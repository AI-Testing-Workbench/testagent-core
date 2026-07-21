import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { File } from "../file"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { Bus } from "../bus"
import { InstanceState } from "@/effect/instance-state"
import { FileWatcher } from "@/file/watcher"
import { ShareNext } from "@/share/share-next"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Layer } from "effect"

const log = Log.create({ service: "bootstrap" })
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const file = yield* File.Service
    const fileWatcher = yield* FileWatcher.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      // Plugin can mutate config so it has to be initialized before anything else.
      const tPlugin0 = performance.now()
      yield* plugin.init()
      const tPlugin1 = performance.now()
      log.info("plugin.init done", { duration: `${Math.round((tPlugin1 - tPlugin0) * 100) / 100}ms` })

      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      const initStart = performance.now()
      type NamedInit = { name: string; svc: { init: () => Effect.Effect<void, unknown> } }
      const named: NamedInit[] = [
        { name: "LSP", svc: lsp },
        { name: "shareNext", svc: shareNext },
        { name: "format", svc: format },
        { name: "file", svc: file },
        { name: "fileWatcher", svc: fileWatcher },
        { name: "vcs", svc: vcs },
        { name: "snapshot", svc: snapshot },
        { name: "project", svc: project },
      ]
      yield* Effect.forEach(
        named,
        (n) =>
          Effect.sync(() => {
            const t0 = performance.now()
            return { n, t0 }
          }).pipe(
            Effect.flatMap(({ n, t0 }) =>
              n.svc.init().pipe(
                Effect.catchCause((cause) =>
                  Effect.sync(() => log.warn(`${n.name}.init failed`, { cause })),
                ),
                Effect.flatMap(() =>
                  Effect.sync(() => {
                    const elapsed = Math.round((performance.now() - t0) * 100) / 100
                    log.info(`${n.name}.init done`, { duration: `${elapsed}ms` })
                  }),
                ),
              ),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
      const initDone = performance.now()
      log.info("all init done", { duration: `${Math.round((initDone - initStart) * 100) / 100}ms` })
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide([
    Bus.layer,
    Config.defaultLayer,
    File.defaultLayer,
    FileWatcher.defaultLayer,
    Format.defaultLayer,
    LSP.defaultLayer,
    Plugin.defaultLayer,
    Project.defaultLayer,
    ShareNext.defaultLayer,
    Snapshot.defaultLayer,
    Vcs.defaultLayer,
  ]),
)

export * as InstanceBootstrap from "./bootstrap"
