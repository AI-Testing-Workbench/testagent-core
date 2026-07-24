import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  WorkspaceAdapter as PluginWorkspaceAdapter,
} from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { Bus } from "../bus"
import { GlobalBus, type GlobalEvent } from "@/bus/global" // testagent_change
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ServerAuth } from "@/server/auth"
import { Session } from "@/session/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { LangfusePlugin } from "./langfuse" // testagent_change
import { MemoryPlugin } from "./testagent-memory/index.js" // testagent_change
import { GoalPlugin } from "./testagent-goal/index" // testagent_change
import { Effect, Layer, Context, Queue, Stream, Metric } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { PluginLoader } from "./loader"
import { parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter } from "@/control-plane/types"

// testagent_change start - VS Code notification helpers
function isVSCodeEnvironment(): boolean {
  return true // 默认就是vscode环境
  // return process.env.KILO_CLIENT === "vscode"
}

// Track if we've already shown the plugin notification to avoid duplicate notifications
// when multiple instances are created (e.g., on session creation)
let hasShownPluginNotification = false

function notifyVSCode(type: "info" | "error", message: string) {
  // Output JSON to stderr with special prefix for VS Code extension to parse
  const notification = JSON.stringify({ type: "plugin-notification", level: type, message })
  console.error(`[TESTAGENT_NOTIFICATION] ${notification}`)
}

function isMessageSyncEvent(type: string) {
  return type === "message.updated" || type === "message.part.updated"
}

function sendEvent(hooks: Hooks[], event: unknown) {
  for (const hook of hooks) {
    void hook["event"]?.({ event: event as any })
  }
}

function eventKey(input: { id?: string; type?: string; properties?: unknown }) {
  if (!input.type || !isMessageSyncEvent(input.type)) return
  if (input.id) return `${input.type}:${input.id}`
  if (!input.properties || typeof input.properties !== "object") return
  const props = input.properties as {
    info?: { id?: string; sessionID?: string }
    part?: { id?: string; messageID?: string; sessionID?: string; type?: string; text?: string }
  }
  if (input.type === "message.updated") {
    const info = props.info
    if (!info) return
    return `${input.type}:${info.sessionID ?? ""}:${info.id ?? ""}`
  }
  const part = props.part
  if (!part) return
  return `${input.type}:${part.sessionID ?? ""}:${part.messageID ?? ""}:${part.id ?? ""}:${part.type ?? ""}:${part.text ?? ""}`
}
// testagent_change end

type State = {
  hooks: Hooks[]
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

// Built-in plugins that are directly imported (not installed from npm)
const INTERNAL_PLUGINS: PluginInstance[] = [
  // testagent_change start - removed unused auth plugins: CodexAuthPlugin, CopilotAuthPlugin, GitlabAuthPlugin, PoeAuthPlugin, CloudflareWorkersAuthPlugin, CloudflareAIGatewayAuthPlugin, AzureAuthPlugin
  LangfusePlugin, // testagent_change
  MemoryPlugin, // testagent_change
  GoalPlugin, // testagent_change
]
// testagent_change end

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

function getLegacyPlugins(mod: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const result: PluginInstance[] = []

  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    result.push(plugin)
  }

  return result
}

async function applyPlugin(load: PluginLoader.Loaded, input: PluginInput, hooks: Hooks[]) {
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    const hook = await (plugin as PluginModule).server(input, load.options)
    if (hook) {
      ;(hook as any)._spec = load.spec // testagent_change - 标记插件来源
      hooks.push(hook)
    }
    return
  }

  for (const server of getLegacyPlugins(load.mod)) {
    const hook = await server(input, load.options)
    if (hook) {
      ;(hook as any)._spec = load.spec // testagent_change - 标记插件来源
      hooks.push(hook)
    }
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        // testagent_change start - log directory to understand multiple initializations
        yield* Effect.logInfo("插件状态正在初始化", {
          directory: ctx.directory,
          worktree: ctx.worktree,
          projectId: ctx.project.id,
        })
        // testagent_change end

        const hooks: Hooks[] = []
        const bridge = yield* EffectBridge.make()

        // Deduplicate plugin error messages across repeated state initializations
        // to prevent the same error from rendering as multiple error cards.
        const sentErrors = new Set<string>()
        function publishPluginError(message: string) {
          if (sentErrors.has(message)) return
          sentErrors.add(message)
          bridge.fork(bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
          // testagent_change - 同步写入 config 警告，确保轮询能捕获
          bridge.fork(config.reportWarning({ path: "plugin", message })) // testagent_change
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const client = createOpencodeClient({
          baseUrl: "http://localhost:4096",
          directory: ctx.directory,
          headers: ServerAuth.headers(),
          fetch: async (...args) => Server.Default().app.fetch(...args),
        })
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          experimental_workspace: {
            register(type: string, adapter: PluginWorkspaceAdapter) {
              registerAdapter(ctx.project.id, type, adapter as WorkspaceAdapter)
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
          // testagent_change start
          metric: (name, value, attributes) => {
            bridge.fork(
              Metric.update(
                Metric.withAttributes(Metric.counter(name), { ...attributes, "data_stream.dataset": "plugins" }),
                value,
              ),
            )
          },
          log: (level, message, data) => {
            bridge.fork(
              Effect.gen(function* () {
                switch (level) {
                  case "debug":
                    yield* Effect.logDebug(message).pipe(
                      Effect.annotateLogs({ ...data, "data_stream.dataset": "plugins" }),
                    )
                    break
                  case "info":
                    yield* Effect.logInfo(message).pipe(
                      Effect.annotateLogs({ ...data, "data_stream.dataset": "plugins" }),
                    )
                    break
                  case "warn":
                    yield* Effect.logWarning(message).pipe(
                      Effect.annotateLogs({ ...data, "data_stream.dataset": "plugins" }),
                    )
                    break
                  case "error":
                    yield* Effect.logError(message).pipe(
                      Effect.annotateLogs({ ...data, "data_stream.dataset": "plugins" }),
                    )
                    break
                }
              }),
            )
          },
          // testagent_change end
        }

        for (const plugin of INTERNAL_PLUGINS) {
          // testagent_change start - skip LangfusePlugin when disabled in config
          if (plugin === LangfusePlugin && cfg.langfuse === false) {
            yield* Effect.logInfo("Langfuse 插件已被配置禁用")
            continue
          }
          if (plugin === GoalPlugin && cfg.goal?.enabled !== true) {
            yield* Effect.logInfo("Goal plugin disabled by config")
            continue
          }
          // testagent_change end
          yield* Effect.logInfo("正在加载内置插件", { name: plugin.name })
          const opts = plugin === GoalPlugin ? cfg.goal : undefined
          const init = yield* Effect.tryPromise({
            try: () => plugin(input, opts),
            catch: (err) => {
              bridge.fork(Effect.logError("内置插件加载失败", { name: plugin.name, error: err }))
            },
          }).pipe(Effect.option)
          if (init._tag === "Some") {
            ;(init.value as any)._spec = plugin.name // testagent_change - 标记插件来源
            hooks.push(init.value)
            yield* Effect.logInfo("内置插件加载成功", { name: plugin.name }) // testagent_change
          }
        }

        const plugins = Flag.OPENCODE_PURE ? [] : (cfg.plugin_origins ?? [])
        if (Flag.OPENCODE_PURE && cfg.plugin_origins?.length) {
          yield* Effect.logInfo("纯模式跳过外部插件", { count: cfg.plugin_origins.length })
        }

        if (!Flag.OPENCODE_PURE && plugins.length === 0) {
          yield* Effect.logInfo("没有外部插件需要加载")
        }

        // testagent_change start - track plugin loading results
        const pluginFailed = new Map<string, string>()
        const pluginResults = {
          success: [] as string[],
          get failed() {
            return Array.from(pluginFailed, ([spec, error]) => ({ spec, error }))
          },
        }
        // testagent_change end

        if (plugins.length) {
          // testagent_change start - notify plugin installation start
          const message = `正在安装 ${plugins.length} 个插件...`
          yield* Effect.logInfo(message)
          // testagent_change end
          yield* config.waitForDependencies()
        }

        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate) {
                // testagent_change start - notify plugin loading start
                const message = `正在加载插件: ${candidate.plan.spec}`
                if (isVSCodeEnvironment()) {
                  // notifyVSCode("info", message)
                } else {
                  bridge.fork(Effect.logInfo(message))
                }
                // testagent_change end
                bridge.fork(Effect.logInfo("正在加载插件", { path: candidate.plan.spec }))
              },
              missing(candidate, _retry, message) {
                bridge.fork(Effect.logWarning("插件没有服务端入口", { path: candidate.plan.spec, message }))
                // testagent_change start - track missing plugin
                if (!pluginFailed.has(candidate.plan.spec)) {
                  pluginFailed.set(candidate.plan.spec, message)
                }
                // testagent_change end
              },
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                // testagent_change start - track failed plugin
                if (!pluginFailed.has(spec)) {
                  pluginFailed.set(spec, message)
                }
                // testagent_change end

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  bridge.fork(
                    Effect.logError("插件安装失败", { pkg: parsed.pkg, version: parsed.version, error: message }),
                  )
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  bridge.fork(Effect.logWarning("插件不兼容", { path: spec, error: message }))
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  bridge.fork(Effect.logError("插件服务端入口解析失败", { path: spec, error: message }))
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                bridge.fork(Effect.logError("插件加载失败", { path: spec, target: resolved?.entry, error: message }))
                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
              success(candidate) {
                // testagent_change start - track successful plugin
                pluginResults.success.push(candidate.plan.spec)
                // testagent_change end
                bridge.fork(Effect.logInfo("插件加载成功", { path: candidate.plan.spec }))
              },
            },
          }),
        )

        // testagent_change start - expose runtime plugin status for settings UI
        cfg.plugin_status = pluginResults
        GlobalBus.emit("event", {
          directory: ctx.directory,
          payload: {
            type: "global.config.updated",
            properties: { directory: ctx.directory, reason: "plugin-status" },
          },
        } satisfies GlobalEvent)
        // testagent_change end

        // testagent_change start - notify all plugins loaded with detailed results
        if (plugins.length) {
          // Only show notification on first load to avoid duplicate notifications
          // when multiple instances are created (e.g., on session creation)
          if (!hasShownPluginNotification) {
            hasShownPluginNotification = true

            // Build detailed message with plugin names
            const successMsg = pluginResults.success.length > 0 ? `✅ 成功: ${pluginResults.success.join(", ")}` : ""
            const failedMsg =
              pluginResults.failed.length > 0 ? `❌ 失败: ${pluginResults.failed.map((f) => f.spec).join(", ")}` : ""

            const message = ["插件加载完成:", successMsg, failedMsg].filter(Boolean).join("\n")
            // notifyVSCode("info", message)
            yield* Effect.logInfo(message)
          } else {
            yield* Effect.logDebug("跳过重复的插件通知", {
              directory: ctx.directory,
              pluginCount: plugins.length,
            })
          }
        }
        // testagent_change end
        for (const load of loaded) {
          if (!load) continue

          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          yield* Effect.tryPromise({
            try: () => applyPlugin(load, input, hooks),
            catch: (err) => {
              const message = errorMessage(err)
              bridge.fork(Effect.logError("插件加载失败", { path: load.spec, error: message }))
              return message
            },
          }).pipe(
            Effect.catch(() => {
              // TODO: make proper events for this
              // bus.publish(Session.Event.Error, {
              //   error: new NamedError.Unknown({
              //     message: `Failed to load plugin ${load.spec}: ${message}`,
              //   }).toObject(),
              // })
              return Effect.void
            }),
          )
        }

        yield* Effect.logInfo("外部插件应用完成", { count: loaded.filter(Boolean).length })

        // Notify plugins of current config
        for (const hook of hooks) {
          yield* Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(cfg)),
            catch: (err) => {
              bridge.fork(Effect.logError("插件配置钩子执行失败", { spec: (hook as any)._spec ?? "unknown", error: err })) // testagent_change
            },
          }).pipe(Effect.ignore)
        }

        // Subscribe to bus events, fiber interrupted when scope closes
        // testagent_change start - dedupe message sync events forwarded through GlobalBus fallback
        const seen = new Set<string>()
        function shouldForward(input: { id?: string; type?: string; properties?: unknown }) {
          const key = eventKey(input)
          if (!key) return true
          if (seen.has(key)) return false
          seen.add(key)
          return true
        }
        // testagent_change end

        yield* bus.subscribeAll().pipe(
          Stream.runForEach((input) =>
            Effect.sync(() => {
              if (!shouldForward(input)) return
              sendEvent(hooks, input)
            }),
          ),
          Effect.forkScoped,
        )

        // testagent_change start - forward message sync events from global bus to plugins
        const workspace = yield* InstanceState.workspaceID
        yield* Stream.callback<GlobalEvent>((queue) => {
          const handler = (event: GlobalEvent) => {
            if (event.directory && event.directory !== ctx.directory) return
            if (event.project && event.project !== ctx.project.id) return
            if (event.workspace && event.workspace !== workspace) return
            const payload = event.payload
            if (!payload || typeof payload !== "object") return
            if (!isMessageSyncEvent(String((payload as { type?: string }).type))) return
            if (!shouldForward(payload as { id?: string; type?: string; properties?: unknown })) return
            Queue.offerUnsafe(queue, event)
          }
          return Effect.acquireRelease(
            Effect.sync(() => GlobalBus.on("event", handler)),
            () => Effect.sync(() => GlobalBus.off("event", handler)),
          )
        }).pipe(
          Stream.runForEach((input) => Effect.sync(() => sendEvent(hooks, input.payload))),
          Effect.forkScoped,
        )
        // testagent_change end

        yield* Effect.logInfo("插件状态初始化完成", { hookCount: hooks.length })

        return { hooks }
      }),
    )

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: Input, output: Output) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      for (const hook of s.hooks) {
        const fn = hook[name] as any
        if (!fn) continue
        yield* Effect.promise(async () => fn(input, output))
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ trigger, list, init })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer), Layer.provide(Config.defaultLayer))

export * as Plugin from "."
