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
import * as Log from "@opencode-ai/core/util/log"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ServerAuth } from "@/server/auth"
import { CodexAuthPlugin } from "./codex"
import { Session } from "@/session/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"
import { PoeAuthPlugin } from "opencode-poe-auth"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
import { AzureAuthPlugin } from "./azure"
import { LangfusePlugin } from "./langfuse" // testagent_change
import { MemoryPlugin } from "./testagent-memory/index.js" // testagent_change
import { Effect, Layer, Context, Queue, Stream } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { PluginLoader } from "./loader"
import { parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter } from "@/control-plane/types"

const log = Log.create({ service: "plugin" })

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
  CodexAuthPlugin,
  CopilotAuthPlugin,
  GitlabAuthPlugin,
  PoeAuthPlugin,
  CloudflareWorkersAuthPlugin,
  CloudflareAIGatewayAuthPlugin,
  AzureAuthPlugin,
  LangfusePlugin, // testagent_change
  MemoryPlugin, // testagent_change
]

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
    hooks.push(await (plugin as PluginModule).server(input, load.options))
    return
  }

  for (const server of getLegacyPlugins(load.mod)) {
    hooks.push(await server(input, load.options))
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
        log.info("Plugin.state initializing", {
          directory: ctx.directory,
          worktree: ctx.worktree,
          projectId: ctx.project.id,
        })
        // testagent_change end

        const hooks: Hooks[] = []
        const bridge = yield* EffectBridge.make()

        function publishPluginError(message: string) {
          bridge.fork(bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
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
        }

        for (const plugin of INTERNAL_PLUGINS) {
          // testagent_change start - skip LangfusePlugin when disabled in config
          if (plugin === LangfusePlugin && cfg.langfuse === false) {
            log.info("langfuse plugin disabled by config")
            continue
          }
          // testagent_change end
          log.info("loading internal plugin", { name: plugin.name })
          const init = yield* Effect.tryPromise({
            try: () => plugin(input),
            catch: (err) => {
              log.error("failed to load internal plugin", { name: plugin.name, error: err })
            },
          }).pipe(Effect.option)
          if (init._tag === "Some") hooks.push(init.value)
        }

        const plugins = Flag.OPENCODE_PURE ? [] : (cfg.plugin_origins ?? [])
        if (Flag.OPENCODE_PURE && cfg.plugin_origins?.length) {
          log.info("skipping external plugins in pure mode", { count: cfg.plugin_origins.length })
        }

        // testagent_change start - track plugin loading results
        const pluginResults = {
          success: [] as string[],
          failed: [] as { spec: string; error: string }[],
        }
        // testagent_change end

        if (plugins.length) {
          // testagent_change start - notify plugin installation start
          const message = `正在安装 ${plugins.length} 个插件...`
          if (isVSCodeEnvironment()) {
            // notifyVSCode("info", message)
          } else {
            log.info(message)
          }
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
                  log.info(message)
                }
                // testagent_change end
                log.info("loading plugin", { path: candidate.plan.spec })
              },
              missing(candidate, _retry, message) {
                log.warn("plugin has no server entrypoint", { path: candidate.plan.spec, message })
                // testagent_change start - track missing plugin
                pluginResults.failed.push({ spec: candidate.plan.spec, error: message })
                // testagent_change end
              },
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                // testagent_change start - track failed plugin
                pluginResults.failed.push({ spec, error: message })
                // testagent_change end

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  log.error("failed to install plugin", { pkg: parsed.pkg, version: parsed.version, error: message })
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  log.warn("plugin incompatible", { path: spec, error: message })
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  log.error("failed to resolve plugin server entry", { path: spec, error: message })
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                log.error("failed to load plugin", { path: spec, target: resolved?.entry, error: message })
                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
              success(candidate) {
                // testagent_change start - track successful plugin
                pluginResults.success.push(candidate.plan.spec)
                // testagent_change end
                log.info("plugin loaded successfully", { path: candidate.plan.spec })
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

            if (isVSCodeEnvironment()) {
              notifyVSCode("info", message)
            } else {
              log.info(message)
            }
          } else {
            log.debug("skipping duplicate plugin notification", {
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
              log.error("failed to load plugin", { path: load.spec, error: message })
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

        // Notify plugins of current config
        for (const hook of hooks) {
          yield* Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(cfg)),
            catch: (err) => {
              log.error("plugin config hook failed", { error: err })
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
