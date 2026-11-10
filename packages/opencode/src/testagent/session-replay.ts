import { Cause, Context, Effect, Layer, Option, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import * as Session from "@/session/session"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { errorMessage } from "@/util/error"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

const log = Log.create({ service: "session.replay" })

export const ReplayInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: PartID,
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReplayInput = Schema.Schema.Type<typeof ReplayInput>

export const MaterializeInput = Schema.Struct({
  sessionID: SessionID,
  snapshot: Schema.String,
  target: Schema.String,
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type MaterializeInput = Schema.Schema.Type<typeof MaterializeInput>

type Copied =
  | { type: "tool"; tool: string; callID: string; input: { [key: string]: any } }
  | { type: "text"; text: string; synthetic?: boolean; ignored?: boolean; metadata?: { [key: string]: any } }
  | { type: "reasoning"; text: string; metadata?: { [key: string]: any } }

function textOf(value: unknown) {
  if (!value || typeof value !== "object") return ""
  const rec = value as { output?: unknown; content?: unknown }
  if (typeof rec.output === "string") return rec.output
  if (!Array.isArray(rec.content)) return ""
  return rec.content
    .flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const row = item as { type?: unknown; text?: unknown }
      if (row.type === "text" && typeof row.text === "string") return [row.text]
      return []
    })
    .join("\n\n")
}

function metaOf(value: unknown) {
  if (!value || typeof value !== "object") return {}
  const rec = value as { metadata?: unknown }
  if (!rec.metadata || typeof rec.metadata !== "object") return {}
  return rec.metadata as Record<string, unknown>
}

function titleOf(value: unknown) {
  if (!value || typeof value !== "object") return ""
  const rec = value as { title?: unknown }
  return typeof rec.title === "string" ? rec.title : ""
}

export interface Interface {
  readonly replay: (input: ReplayInput) => Effect.Effect<MessageV2.WithParts>
  readonly materialize: (input: MaterializeInput) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionReplay") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const state = yield* SessionRunState.Service
    const registry = yield* ToolRegistry.Service
    const mcp = yield* MCP.Service
    const plugin = yield* Plugin.Service
    const permission = yield* Permission.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service

    const last = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user")
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 })
      if (msgs.length > 0) return msgs[0]
      throw new Error("Impossible")
    })

    const replay = Effect.fn("SessionReplay.replay")(function* (input: ReplayInput) {
      yield* state.assertNotBusy(input.sessionID)
      const sess = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (sess.revert) throw new Error("session is reverted")

      const msgs = yield* sessions.messages({ sessionID: input.sessionID })
      const msg = msgs.find((item) => item.info.id === input.messageID)
      if (!msg) throw new Error("message not found")
      if (msg.info.role !== "assistant") throw new Error("replay target is not an assistant message")

      const idx = msg.parts.findIndex((part) => part.id === input.partID)
      if (idx < 0) throw new Error("step not found")
      const head = msg.parts[idx]
      if (head.type !== "step-start") throw new Error("part is not a model step")

      const rest = msg.parts.slice(idx + 1)
      const next = rest.findIndex((part) => part.type === "step-start")
      const slice = next < 0 ? rest : rest.slice(0, next)
      if (!slice.some((part) => part.type === "step-finish")) throw new Error("step is not finished")

      const copied: Copied[] = []
      for (const part of slice) {
        if (part.type === "tool") {
          copied.push({ type: "tool", tool: part.tool, callID: part.callID, input: part.state.input })
          continue
        }
        if (part.type === "text") {
          copied.push({
            type: "text",
            text: part.text,
            synthetic: part.synthetic,
            ignored: part.ignored,
            metadata: part.metadata,
          })
          continue
        }
        if (part.type === "reasoning") {
          copied.push({ type: "reasoning", text: part.text, metadata: part.metadata })
        }
      }
      const finish = slice.find((part) => part.type === "step-finish")
      const later = msgs.filter((item) => item.info.id > msg.info.id).map((item) => item.info.id)
      const drop = msg.parts.slice(idx).map((part) => part.id)
      const shot = head.snapshot
      if (!shot) throw new Error("该步骤没有文件快照，无法回放")
      const agent = yield* agents.get(msg.info.agent)
      const model = yield* provider.getModel(msg.info.providerID, msg.info.modelID).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
      const defs = yield* registry.all()
      const named = new Map(defs.map((item) => [item.id, item]))
      const abort = new AbortController()
      const info = msg.info

      log.info("replay", { sessionID: input.sessionID, messageID: input.messageID, partID: input.partID })

      return yield* state.ensureRunning(
        input.sessionID,
        Effect.gen(function* () {
          abort.abort()
          return yield* last(input.sessionID)
        }),
        Effect.gen(function* () {
          for (const id of later) {
            yield* sessions.removeMessage({ sessionID: input.sessionID, messageID: id })
          }
          for (const id of drop) {
            yield* sessions.removePart({
              sessionID: input.sessionID,
              messageID: info.id,
              partID: id,
            })
          }

          yield* sessions.updateMessage({
            ...info,
            finish: undefined,
            error: undefined,
            time: { ...info.time, completed: undefined },
          })

          const hash = yield* snap.track()
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: info.id,
            sessionID: input.sessionID,
            snapshot: hash,
            type: "step-start",
          })

          const mcpTools = yield* mcp.tools()

          for (const part of copied) {
            if (abort.signal.aborted) break
            if (part.type === "text") {
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                text: part.text,
                synthetic: part.synthetic,
                ignored: part.ignored,
                metadata: part.metadata,
                time: { start: Date.now(), end: Date.now() },
              })
              continue
            }
            if (part.type === "reasoning") {
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "reasoning",
                text: part.text,
                metadata: part.metadata,
                time: { start: Date.now(), end: Date.now() },
              })
              continue
            }

            const started = Date.now()
            const ref: { part: MessageV2.ToolPart } = {
              part: yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "tool",
                tool: part.tool,
                callID: part.callID,
                state: { status: "running", input: part.input, time: { start: started } },
              } satisfies MessageV2.ToolPart),
            }

            const fail = (text: string) =>
              sessions
                .updatePart({
                  id: ref.part.id,
                  messageID: ref.part.messageID,
                  sessionID: ref.part.sessionID,
                  type: "tool",
                  tool: part.tool,
                  callID: part.callID,
                  state: {
                    status: "error",
                    input: part.input,
                    error: text,
                    time: { start: started, end: Date.now() },
                  },
                } satisfies MessageV2.ToolPart)
                .pipe(
                  Effect.map((row) => {
                    ref.part = row
                  }),
                )

            const live = yield* sessions.messages({ sessionID: input.sessionID })
            const ctx: Tool.Context = {
              sessionID: input.sessionID,
              abort: abort.signal,
              messageID: info.id,
              callID: part.callID,
              extra: { model, bypassAgentCheck: false },
              agent: agent.name,
              messages: live,
              metadata: (val) =>
                Effect.gen(function* () {
                  if (!["running", "pending"].includes(ref.part.state.status)) return
                  const row = yield* sessions.updatePart({
                    id: ref.part.id,
                    messageID: ref.part.messageID,
                    sessionID: ref.part.sessionID,
                    type: "tool",
                    tool: part.tool,
                    callID: part.callID,
                    state: {
                      status: "running",
                      title: val.title,
                      metadata: val.metadata,
                      input: part.input,
                      time: { start: started },
                    },
                  } satisfies MessageV2.ToolPart)
                  ref.part = row
                }),
              ask: (req) =>
                permission
                  .ask({
                    ...req,
                    sessionID: input.sessionID,
                    tool: { messageID: info.id, callID: part.callID },
                    ruleset: Permission.merge(agent.permission, sess.permission ?? []),
                  })
                  .pipe(Effect.orDie),
            }

            const def = named.get(part.tool)
            const mcpItem = mcpTools[part.tool]
            yield* Effect.gen(function* () {
              if (def) {
                yield* plugin.trigger(
                  "tool.execute.before",
                  { tool: def.id, sessionID: ctx.sessionID, callID: part.callID },
                  { args: part.input },
                )
                const result = yield* def.execute(part.input as never, ctx)
                const attachments = result.attachments?.map((item) => ({
                  ...item,
                  id: PartID.ascending(),
                  sessionID: ctx.sessionID,
                  messageID: info.id,
                }))
                yield* plugin.trigger(
                  "tool.execute.after",
                  { tool: def.id, sessionID: ctx.sessionID, callID: part.callID, args: part.input },
                  { ...result, attachments },
                )
                const row = yield* sessions.updatePart({
                  id: ref.part.id,
                  messageID: ref.part.messageID,
                  sessionID: ref.part.sessionID,
                  type: "tool",
                  tool: part.tool,
                  callID: part.callID,
                  state: {
                    status: "completed",
                    input: part.input,
                    output: result.output,
                    title: result.title,
                    metadata: result.metadata,
                    time: { start: started, end: Date.now() },
                    attachments,
                  },
                } satisfies MessageV2.ToolPart)
                ref.part = row
                return
              }

              const run = mcpItem?.execute
              if (!run) {
                yield* fail("未知工具，无法回放执行")
                return
              }

              yield* plugin.trigger(
                "tool.execute.before",
                { tool: part.tool, sessionID: ctx.sessionID, callID: part.callID },
                { args: part.input },
              )
              const raw = yield* Effect.tryPromise({
                try: () =>
                  Promise.resolve(
                    run(part.input, {
                      abortSignal: abort.signal,
                      toolCallId: part.callID,
                    } as never),
                  ),
                catch: (err) => err,
              })
              const output = {
                title: titleOf(raw),
                metadata: metaOf(raw),
                output: textOf(raw),
              }
              yield* plugin.trigger(
                "tool.execute.after",
                { tool: part.tool, sessionID: ctx.sessionID, callID: part.callID, args: part.input },
                output,
              )
              const row = yield* sessions.updatePart({
                id: ref.part.id,
                messageID: ref.part.messageID,
                sessionID: ref.part.sessionID,
                type: "tool",
                tool: part.tool,
                callID: part.callID,
                state: {
                  status: "completed",
                  input: part.input,
                  output: output.output,
                  title: output.title,
                  metadata: output.metadata,
                  time: { start: started, end: Date.now() },
                },
              } satisfies MessageV2.ToolPart)
              ref.part = row
            }).pipe(Effect.catchCause((cause) => fail(errorMessage(Cause.squash(cause)))))
          }

          const done = yield* snap.track()
          yield* sessions.updatePart({
            id: PartID.ascending(),
            reason: finish && finish.type === "step-finish" ? finish.reason : "stop",
            snapshot: done,
            messageID: info.id,
            sessionID: input.sessionID,
            type: "step-finish",
            tokens:
              finish && finish.type === "step-finish"
                ? finish.tokens
                : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: finish && finish.type === "step-finish" ? finish.cost : 0,
          })

          if (hash) {
            const patch = yield* snap.patch(hash)
            if (patch.files.length) {
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: info.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
          }

          yield* sessions.updateMessage({
            ...info,
            finish: finish && finish.type === "step-finish" ? finish.reason : info.finish,
            error: undefined,
            time: { ...info.time, completed: Date.now() },
          })
          return yield* last(input.sessionID)
        }),
      )
    })

    const materialize = Effect.fn("SessionReplay.materialize")(function* (input: MaterializeInput) {
      log.info("materialize", { sessionID: input.sessionID, snapshot: input.snapshot, target: input.target })
      yield* snap.materialize(input.snapshot, input.target)
    })

    return Service.of({ replay, materialize })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(ToolRegistry.defaultLayer),
    Layer.provide(MCP.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Permission.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Provider.defaultLayer),
  ),
)

export * as SessionReplay from "./session-replay"
