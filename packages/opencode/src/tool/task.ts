import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import type { SessionPrompt } from "../session/prompt"
import { IdleReason } from "@/session/status"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Effect, Exit, Metric, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { taskCall } from "@opencode-ai/core/effect/observability"

// testagent_change start - subagent 取消支持传入 idle reason
export interface TaskPromptOps {
  cancel(sessionID: SessionID, reason?: IdleReason): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}
// testagent_change end

const id = "task"

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
})

// testagent_change start - subagent model resolution
type SubagentModel = { modelID: string; providerID: string; variant?: string }

function parseModelID(raw: string | null | undefined): { modelID: string; providerID: string } | undefined {
  if (!raw) return undefined
  const slash = raw.indexOf("/")
  if (slash <= 0 || slash >= raw.length - 1) return undefined
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) }
}

function resolveSubagentModel(
  cfg: { subagent_model?: string | null; subagent_variant?: string | null; subagent_variant_overrides?: Record<string, string | null> | null },
  agent: { model?: { modelID: string; providerID: string } | null },
  parent: { modelID: string; providerID: string },
): SubagentModel {
  // Priority: subagent_model config > agent model > parent model
  const cfgModel = parseModelID(cfg.subagent_model)
  const base = cfgModel ?? agent.model ?? parent

  // Variant: overrides > subagent_variant
  const key = `${base.providerID}/${base.modelID}`
  const override = cfg.subagent_variant_overrides?.[key]
  const variant = override ?? cfg.subagent_variant ?? undefined

  return variant ? { ...base, variant } : base
}
// testagent_change end

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const sid = yield* sessions.get(ctx.sessionID)
      yield* Metric.update(Metric.withAttributes(taskCall, { sessionID: ctx.sessionID, subagent_type: params.subagent_type, modelID: sid.model?.id ?? "", providerID: sid.model?.providerID ?? "" }), 1)

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const canTask = next.permission.some((rule) => rule.permission === id)
      const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parent = yield* sessions.get(ctx.sessionID)
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          permission: [
            ...(parent.permission ?? []).filter(
              (rule) => rule.permission === "external_directory" || rule.action === "deny",
            ),
            ...(canTodo
              ? []
              : [
                  {
                    permission: "todowrite" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(canTask
              ? []
              : [
                  {
                    permission: id,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        }))

      // testagent_change start - apply per-stage subagent override to child session
      const override = (ctx.extra?.override as
        | { prompt?: string; permission?: Permission.Ruleset; temperature?: number; topP?: number; steps?: number }
        | undefined)
      if (override) {
        if (override.permission && override.permission.length > 0) {
          // 追加覆盖：基准权限 + override 规则在末尾（findLast 后到者优先）
          yield* sessions.setPermission({
            sessionID: nextSession.id,
            permission: Permission.merge(nextSession.permission ?? [], override.permission),
          })
        }
        // 继承 override（prompt + permission + temperature + topP + steps）到子会话，供子会话 agent 解析时
        // 正确反映角色提示词和工具权限（Skill.available / resolveTools 都走 agent.permission）
        yield* agent.setSessionOverride({
          sessionID: nextSession.id,
          prompt: override.prompt,
          permission: override.permission,
          temperature: override.temperature,
          topP: override.topP,
          steps: override.steps,
        })
      }
      // testagent_change end

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      // testagent_change start - subagent model resolution with priority chain
      const parentModel = { modelID: msg.info.modelID, providerID: msg.info.providerID }
      const model = resolveSubagentModel(cfg, next, parentModel)
      // testagent_change end

      yield* ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: nextSession.id,
          model,
        },
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      const runCancel = yield* EffectBridge.make()

      const messageID = MessageID.ascending()
      // testagent_change - 父 agent 被用户中止时会中断本 TaskTool,释放块据此取消
      // subagent;这里把 reason 写为 user_abort,使被牵连取消的 subagent 也标记为 user_abort。
      const cancel = ops.cancel(nextSession.id, "user_abort")

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const parts = yield* ops.resolvePromptParts(params.prompt)
            const result = yield* ops.prompt({
              messageID,
              sessionID: nextSession.id,
              model: {
                modelID: model.modelID,
                providerID: model.providerID,
                ...(model.variant ? { variant: model.variant } : {}),
              },
              agent: next.name,
              tools: {
                ...(canTodo ? {} : { todowrite: false }),
                ...(canTask ? {} : { task: false }),
                ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
              },
              parts,
            })

            return {
              title: params.description,
              metadata: {
                sessionId: nextSession.id,
                model,
              },
              output: [
                `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
                "",
                "<task_result>",
                result.parts.findLast((item) => item.type === "text")?.text ?? "",
                "</task_result>",
              ].join("\n"),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) yield* cancel
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                // testagent_change start - 子会话执行结束清除其 override，避免条目积累与 resume 时套用旧配置
                yield* agent.clearSessionOverride({ sessionID: nextSession.id })
                // testagent_change end
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
