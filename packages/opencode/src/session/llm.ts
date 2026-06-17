import { Provider } from "@/provider/provider"
import * as Log from "@opencode-ai/core/util/log"
import { Context, Effect, Layer, Record } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool, tool, jsonSchema } from "ai"
import { mergeDeep } from "remeda"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { EffectBridge } from "@/effect/bridge"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { ModelIOAudit } from "@/testagent/model-io-audit"

const log = Log.create({ service: "llm" })
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX
type Result = Awaited<ReturnType<typeof streamText>>

// Avoid re-instantiating remeda's deep merge types in this hot LLM path; the runtime behavior is still mergeDeep.
const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export type StreamInput = {
  user: MessageV2.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export type Event = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<Event, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

const live: Layer.Layer<
  Service,
  never,
  Auth.Service | Config.Service | Provider.Service | Plugin.Service | Permission.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      const l = log
        .clone()
        .tag("providerID", input.model.providerID)
        .tag("modelID", input.model.id)
        .tag("session.id", input.sessionID)
        .tag("small", (input.small ?? false).toString())
        .tag("agent", input.agent.name)
        .tag("mode", input.agent.mode)
      l.info("stream", {
        modelID: input.model.id,
        providerID: input.model.providerID,
      })

      const [language, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      // TODO: move this to a proper hook
      const isOpenaiOauth = item.id === "openai" && info?.type === "oauth"

      const system: string[] = []
      system.push(
        [
          // use agent prompt otherwise provider prompt
          ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
          // any custom prompt passed into this call
          ...input.system,
          // any custom prompt from last user message
          ...(input.user.system ? [input.user.system] : []),
        ]
          .filter((x) => x)
          .join("\n"),
      )

      const header = system[0]
      yield* plugin.trigger(
        "experimental.chat.system.transform",
        { sessionID: input.sessionID, model: input.model },
        { system },
      )
      // rejoin to maintain 2-part structure for caching if header unchanged
      if (system.length > 2 && system[0] === header) {
        const rest = system.slice(1)
        system.length = 0
        system.push(header, rest.join("\n"))
      }

      const variant =
        !input.small && input.model.variants && input.user.model.variant
          ? input.model.variants[input.user.model.variant]
          : {}
      const base = input.small
        ? ProviderTransform.smallOptions(input.model)
        : ProviderTransform.options({
            model: input.model,
            sessionID: input.sessionID,
            providerOptions: item.options,
          })
      const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
      if (isOpenaiOauth) {
        options.instructions = system.join("\n")
      }

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const messages = isOpenaiOauth
        ? input.messages
        : isWorkflow
          ? input.messages
          : [
              ...system.map(
                (x): ModelMessage => ({
                  role: "system",
                  content: x,
                }),
              ),
              ...input.messages,
            ]

      const tools = resolveTools(input)
      const activeTools = Object.keys(tools).filter((x) => x !== "invalid") // testagent_change

      const params = yield* plugin.trigger(
        "chat.params",
        {
          sessionID: input.sessionID,
          agent: input.agent.name,
          model: input.model,
          provider: item,
          message: input.user,
          activeTools, // testagent_change
        },
        {
          temperature: input.model.capabilities.temperature
            ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
            : undefined,
          topP: input.agent.topP ?? ProviderTransform.topP(input.model),
          topK: ProviderTransform.topK(input.model),
          maxOutputTokens:  input.model.limit.output == 0 ? undefined : ProviderTransform.maxOutputTokens(input.model),
          options,
        },
      )

      const { headers } = yield* plugin.trigger(
        "chat.headers",
        {
          sessionID: input.sessionID,
          agent: input.agent.name,
          model: input.model,
          provider: item,
          message: input.user,
        },
        {
          headers: {},
        },
      )

      // LiteLLM and some Anthropic proxies require the tools parameter to be present
      // when message history contains tool calls, even if no tools are being used.
      // Add a dummy tool that is never called to satisfy this validation.
      // This is enabled for:
      // 1. Providers with "litellm" in their ID or API ID (auto-detected)
      // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
      const isLiteLLMProxy =
        item.options?.["litellmProxy"] === true ||
        input.model.providerID.toLowerCase().includes("litellm") ||
        input.model.api.id.toLowerCase().includes("litellm")

      // LiteLLM/Bedrock rejects requests where the message history contains tool
      // calls but no tools param is present. When there are no active tools (e.g.
      // during compaction), inject a stub tool to satisfy the validation requirement.
      // The stub description explicitly tells the model not to call it.
      if (
        (isLiteLLMProxy || input.model.providerID.includes("github-copilot")) &&
        Object.keys(tools).length === 0 &&
        hasToolCalls(input.messages)
      ) {
        tools["_noop"] = tool({
          description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              reason: { type: "string", description: "Unused" },
            },
          }),
          execute: async () => ({ output: "", title: "", metadata: {} }),
        })
      }
      const sortedTools = Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b)))

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      if (language instanceof GitLabWorkflowLanguageModel) {
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          const t = sortedTools[toolName]
          ModelIOAudit.record({
            event: "tool.call.summary",
            status: "started",
            sessionID: input.sessionID,
            messageID: input.user.id,
            toolCallID: _requestID,
            toolName,
            input: argsJson,
            source: "workflow",
          })
          if (!t || !t.execute) {
            ModelIOAudit.record({
              event: "tool.call.summary",
              status: "failed",
              issue: "未知工具",
              sessionID: input.sessionID,
              messageID: input.user.id,
              toolCallID: _requestID,
              toolName,
              error: { message: `Unknown tool: ${toolName}` },
              source: "workflow",
            })
            return { result: "", error: `Unknown tool: ${toolName}` }
          }
          try {
            const args = JSON.parse(argsJson)
            ModelIOAudit.record({
              event: "tool.call.summary",
              status: "input",
              sessionID: input.sessionID,
              messageID: input.user.id,
              toolCallID: _requestID,
              toolName,
              input: args,
              source: "workflow",
            })
            const result = await t.execute!(args, {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            ModelIOAudit.record({
              event: "tool.call.summary",
              status: "completed",
              sessionID: input.sessionID,
              messageID: input.user.id,
              toolCallID: _requestID,
              toolName,
              output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
              source: "workflow",
            })
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            ModelIOAudit.record({
              event: "tool.call.summary",
              status: e instanceof SyntaxError ? "invalid_arguments" : "failed",
              issue: e instanceof SyntaxError ? "工具参数 JSON 构建异常" : "工具执行异常",
              sessionID: input.sessionID,
              messageID: input.user.id,
              toolCallID: _requestID,
              toolName,
              input: argsJson,
              error: ModelIOAudit.error(e),
              source: "workflow",
            })
            return { result: "", error: e.message ?? String(e) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(sortedTools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const bridge = yield* EffectBridge.make()
        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = InstanceState.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionID.ascending()
          let unsub: (() => void) | undefined
          try {
            unsub = Bus.subscribe(Permission.Event.Replied, (evt) => {
              if (evt.properties.requestID === id) void evt.properties.reply
            })
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            unsub?.()
          }
        })
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      const opencodeProjectID = input.model.providerID.startsWith("opencode")
        ? (yield* InstanceState.context).project.id
        : undefined

      ModelIOAudit.record({
        event: "model.request.sent",
        sessionID: input.sessionID,
        messageID: input.user.id,
        providerID: input.model.providerID,
        modelID: input.model.id,
        agent: input.agent.name,
        messageCount: messages.length,
        toolCount: Object.keys(sortedTools).filter((x) => x !== "invalid").length,
        toolChoice: input.toolChoice,
        params: {
          temperature: params.temperature,
          topP: params.topP,
          topK: params.topK,
          maxOutputTokens: params.maxOutputTokens,
        },
        headers: {
          ...(input.model.providerID.startsWith("opencode")
            ? {
                "x-opencode-project": opencodeProjectID,
                "x-opencode-session": input.sessionID,
                "x-opencode-request": input.user.id,
                "x-opencode-client": Flag.OPENCODE_CLIENT,
                "User-Agent": `opencode/${InstallationVersion}`,
              }
            : {
                "x-session-affinity": input.sessionID,
                ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
                "User-Agent": `opencode/${InstallationVersion}`,
              }),
          ...input.model.headers,
          ...headers,
        },
      })

      return streamText({
        onError(error) {
          l.error("stream error", {
            error,
          })
        },
        async experimental_repairToolCall(failed) {
          const lower = failed.toolCall.toolName.toLowerCase()
          if (lower !== failed.toolCall.toolName && sortedTools[lower]) {
            l.info("repairing tool call", {
              tool: failed.toolCall.toolName,
              repaired: lower,
            })
            return {
              ...failed.toolCall,
              toolName: lower,
            }
          }
          return {
            ...failed.toolCall,
            input: JSON.stringify({
              tool: failed.toolCall.toolName,
              error: failed.error.message,
            }),
            toolName: "invalid",
          }
        },
        temperature: params.temperature,
        topP: params.topP,
        topK: params.topK,
        providerOptions: ProviderTransform.providerOptions(input.model, params.options),
        activeTools: Object.keys(sortedTools).filter((x) => x !== "invalid"),
        tools: sortedTools,
        toolChoice: input.toolChoice,
        maxOutputTokens: params.maxOutputTokens,
        abortSignal: input.abort,
        headers: {
          ...(input.model.providerID.startsWith("opencode")
            ? {
                "x-opencode-project": opencodeProjectID,
                "x-opencode-session": input.sessionID,
                "x-opencode-request": input.user.id,
                "x-opencode-client": Flag.OPENCODE_CLIENT,
                "User-Agent": `opencode/${InstallationVersion}`,
              }
            : {
                "x-session-affinity": input.sessionID,
                ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
                "User-Agent": `opencode/${InstallationVersion}`,
              }),
          ...input.model.headers,
          ...headers,
        },
        maxRetries: input.retries ?? 0,
        messages,
        model: wrapLanguageModel({
          model: language,
          middleware: [
            {
              specificationVersion: "v3" as const,
              async transformParams(args) {
                if (args.type === "stream") {
                  // @ts-expect-error
                  args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
                }
                return args.params
              },
            },
          ],
        }),
        experimental_telemetry: {
          isEnabled: cfg.experimental?.openTelemetry,
          functionId: "session.llm",
          tracer: telemetryTracer,
          metadata: {
            userId: cfg.username ?? "unknown",
            sessionId: input.sessionID,
          },
        },
      })
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })
            const audit = createStreamAudit(input)

            return Stream.fromAsyncIterable(result.fullStream, (e) => (e instanceof Error ? e : new Error(String(e)))).pipe(
              Stream.tap((event) => Effect.sync(() => audit.capture(event))),
              Stream.tapError((error) => Effect.sync(() => audit.fail(error))),
              Stream.ensuring(Effect.sync(() => audit.flush())),
            )
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const layer = live.pipe(Layer.provide(Permission.defaultLayer))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
  ),
)

function createStreamAudit(input: StreamInput) {
  const started = Date.now()
  const toolInputs: Record<string, { toolName?: string; raw: string; parsed?: unknown; error?: unknown }> = {}
  const toolCalls: Array<{ toolCallID: string; toolName: string; input: unknown }> = []
  const toolResults: Array<{ toolCallID: string; output: unknown }> = []
  const toolErrors: Array<{ toolCallID: string; error: unknown }> = []
  const text: string[] = []
  const reasoning: string[] = []
  const finishReasons: string[] = []
  const issues: string[] = []
  let events = 0
  let completed = false
  let failed: unknown

  return {
    capture(event: Event) {
      events++
      switch (event.type) {
        case "text-delta":
          text.push(event.text)
          return

        case "reasoning-delta":
          reasoning.push(event.text)
          return

        case "tool-input-start":
          toolInputs[event.id] = { toolName: event.toolName, raw: "" }
          return

        case "tool-input-delta":
          if (!toolInputs[event.id]) toolInputs[event.id] = { raw: "" }
          toolInputs[event.id].raw += event.delta
          return

        case "tool-input-end": {
          const item = toolInputs[event.id]
          if (!item?.raw) return
          try {
            item.parsed = JSON.parse(item.raw)
          } catch (error) {
            item.error = error
            issues.push(`工具参数 JSON 构建异常：${item.toolName ?? "unknown"}(${event.id})`)
          }
          return
        }

        case "tool-call":
          toolCalls.push({ toolCallID: event.toolCallId, toolName: event.toolName, input: event.input })
          return

        case "tool-result":
          toolResults.push({ toolCallID: event.toolCallId, output: event.output })
          return

        case "tool-error":
          toolErrors.push({ toolCallID: event.toolCallId, error: ModelIOAudit.error(event.error) })
          issues.push(`工具执行异常：${event.toolCallId}`)
          return

        case "finish-step":
          finishReasons.push(event.finishReason)
          if (event.finishReason === "length") issues.push("模型输出被长度限制截断")
          if (event.finishReason === "error") issues.push("模型 step 以 error 结束")
          return

        case "finish":
          completed = true
          return

        case "error":
          failed = event.error
          issues.push("模型流返回 error 事件")
          return
      }
    },
    fail(error: unknown) {
      failed = error
      issues.push("模型流异常中断")
    },
    flush() {
      if (!completed && !failed) issues.push("模型流未收到 finish，可能提前中断")
      if (looksLooping(text.join(""))) issues.push("疑似模型循环输出：文本存在连续重复片段")
      for (const call of repeatedToolCalls(toolCalls)) issues.push(`疑似工具循环调用：${call}`)

      ModelIOAudit.record({
        event: "model.response.summary",
        sessionID: input.sessionID,
        messageID: input.user.id,
        providerID: input.model.providerID,
        modelID: input.model.id,
        agent: input.agent.name,
        durationMs: Date.now() - started,
        completed,
        finishReasons,
        issueCount: issues.length,
        issues,
        output: {
          text: text.join(""),
          reasoning: reasoning.join(""),
        },
        tools: {
          arguments: Object.entries(toolInputs).map(([toolCallID, item]) => ({
            toolCallID,
            toolName: item.toolName,
            raw: item.raw,
            parsed: item.parsed,
            parseError: item.error ? ModelIOAudit.error(item.error) : undefined,
          })),
          calls: toolCalls,
          results: toolResults,
          errors: toolErrors,
        },
        stream: {
          eventCount: events,
          failed: failed ? ModelIOAudit.error(failed) : undefined,
        },
      })
    },
  }
}

function looksLooping(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length < 200) return false
  const tail = normalized.slice(-1200)
  const chunks: string[] = tail.match(/.{40,120}/g) ?? []
  return chunks.some((chunk, index) => chunks.indexOf(chunk) !== index)
}

function repeatedToolCalls(calls: Array<{ toolName: string; input: unknown }>) {
  return Object.entries(
    calls.reduce<Record<string, number>>((acc, call) => {
      const key = `${call.toolName}:${JSON.stringify(call.input)}`
      acc[key] = (acc[key] ?? 0) + 1
      return acc
    }, {}),
  )
    .filter(([, count]) => count >= 3)
    .map(([key, count]) => `${key} x${count}`)
}

function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

// Check if messages contain any tool-call content
// Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLM from "./llm"
