import { Config } from "@/config/config"
import { ConfigAgent } from "@/config/agent" // testagent_change
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"
import { ConfigOverlayPatch } from "../groups/config" // testagent_change

const log = Log.create({ service: "config-api" }) // testagent_change

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    // testagent_change start - add overlay endpoints
    const overlay = Effect.fn("ConfigHttpApi.overlay")(function* () {
      const project = yield* configSvc.getProject()
      return { project }
    })

    const overlayUpdate = Effect.fn("ConfigHttpApi.overlayUpdate")(function* (ctx: {
      payload: typeof ConfigOverlayPatch.Type
    }) {
      // Build the patch: start with `set`, then apply `unset` as null values
      const body = {
        ...ctx.payload,
        scope: ctx.payload.scope ?? "project",
        set: ctx.payload.set ? { ...ctx.payload.set } : undefined,
        unset: ctx.payload.unset?.map((item) => [...item]),
      }
      const patch = body.set ?? {}
      // Apply unset paths as null values (null = delete key, stripped by stripNulls on reload)
      for (const path of body.unset ?? []) {
        let target = patch as Record<string, unknown>
        for (let i = 0; i < path.length - 1; i++) {
          if (!target[path[i]] || typeof target[path[i]] !== "object") {
            target[path[i]] = {}
          }
          target = target[path[i]] as Record<string, unknown>
        }
        target[path[path.length - 1]] = null
      }
      log.info("overlayUpdate", { scope: body.scope, keys: Object.keys(patch) })
      if (Object.keys(patch).length === 0) {
        if (body.scope === "global") return yield* configSvc.getGlobal()
        return yield* configSvc.get()
      }

      // Separate .md agent changes from json config changes (for both scopes)
      const instance = yield* InstanceState.context
      const dirs = yield* configSvc.directories().pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const tdirs = yield* configSvc.testagentDirectories().pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const allDirs = [...dirs, ...tdirs]
      const wk = instance.worktree
      // Separate dirs into project and global for md detection
      const projectDirs = allDirs.filter((d) =>
        wk && wk !== "/" ? d.startsWith(wk) : d.startsWith(instance.directory),
      )
      const globalDirs = allDirs.filter(
        (d) => !(wk && wk !== "/" ? d.startsWith(wk) : d.startsWith(instance.directory)),
      )
      const mdDirs = body.scope === "project" ? projectDirs : globalDirs
      const mdNames = new Set<string>()
      for (const d of mdDirs) {
        const names = yield* Effect.promise(() => ConfigAgent.listMdAgentNames(d)).pipe(
          Effect.catch(() => Effect.succeed(new Set<string>())),
        )
        for (const n of names) mdNames.add(n)
      }

      const mdPatch: Record<string, unknown> = {}
      const jsonPatch: Record<string, unknown> = {}

      for (const [key, value] of Object.entries(patch)) {
        if (key === "agent" && typeof value === "object" && value !== null) {
          const mdAgents: Record<string, unknown> = {}
          const jsonAgents: Record<string, unknown> = {}
          for (const [agentName, agentCfg] of Object.entries(value as Record<string, unknown>)) {
            if (mdNames.has(agentName)) {
              mdAgents[agentName] = agentCfg
            } else {
              jsonAgents[agentName] = agentCfg
            }
          }
          if (Object.keys(mdAgents).length > 0) mdPatch.agent = mdAgents
          if (Object.keys(jsonAgents).length > 0) jsonPatch.agent = jsonAgents
        } else {
          jsonPatch[key] = value
        }
      }

      // Write .md-based agents back to their .md files (or delete if nulled out)
      if (Object.keys(mdPatch).length > 0) {
        for (const [name, cfg] of Object.entries((mdPatch.agent ?? {}) as Record<string, unknown>)) {
          const mdFile = yield* Effect.promise(async () => {
            for (const d of mdDirs) {
              const fp = await ConfigAgent.findMdFile(d, name)
              if (fp) return fp
            }
            return undefined
          }).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (mdFile) {
            // Entire agent config is null → delete the .md file
            if (cfg === null) {
              yield* Effect.promise(async () => {
                const { default: fs } = await import("fs/promises")
                await fs.unlink(mdFile)
              }).pipe(
                Effect.catch((err) => {
                  log.error("failed to delete agent .md file", { name, error: String(err) })
                  return Effect.void
                }),
              )
            } else {
              yield* Effect.promise(() => ConfigAgent.saveToFile(mdFile, cfg as any)).pipe(
                Effect.catch((err) => {
                  log.error("failed to save agent .md file", { name, error: String(err) })
                  return Effect.void
                }),
              )
            }
          } else {
            log.warn("no .md file found for agent", { name })
          }
        }
      }

      // Write non-md changes to the appropriate config scope
      if (body.scope === "global") {
        if (Object.keys(jsonPatch).length > 0) {
          yield* configSvc.updateGlobal(jsonPatch)
        }
        if (Object.keys(mdPatch).length > 0 || Object.keys(jsonPatch).length > 0) {
          yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }).pipe(
            Effect.catchCause(() => Effect.void),
          )
        }
        return yield* configSvc.getGlobal()
      }

      // Project scope
      if (Object.keys(jsonPatch).length > 0) {
        yield* configSvc.update(jsonPatch)
      }
      if (Object.keys(mdPatch).length > 0 || Object.keys(jsonPatch).length > 0) {
        yield* markInstanceForDisposal(yield* InstanceState.context)
      }
      return yield* configSvc.get()
    })
    // testagent_change end

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers
      .handle("get", get)
      .handle("update", update)
      .handle("overlay", overlay)
      .handle("overlayUpdate", overlayUpdate)
      .handle("providers", providers) // testagent_change
  }),
)
