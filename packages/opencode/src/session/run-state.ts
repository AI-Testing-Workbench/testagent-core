import { InstanceState } from "@/effect/instance-state"
import { Runner } from "@/effect/runner"
import { Effect, Latch, Layer, Scope, Context, Metric } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus, type IdleReason } from "./status"
import { sessionTotalDuration, sessionWaitDuration, sessionActualDuration } from "@opencode-ai/core/effect/observability"
import { getPermissionWaitTotal } from "../cli/cmd/run/stream.transport"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "run-state" })

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancel: (sessionID: SessionID, reason?: IdleReason) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<MessageV2.WithParts>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()
        const idleReason = new Map<SessionID, IdleReason>()
        const busyStart = new Map<SessionID, number>() // testagent_change
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, idleReason, busyStart, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<MessageV2.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          const reason = data.idleReason.get(sessionID) ?? "completed"
          data.idleReason.delete(sessionID)
          // testagent_change start - report session duration metrics
          const start = data.busyStart.get(sessionID)
          log.info(`Session ${sessionID} idle, reason: ${reason}, busy start: ${start}`)
          if (start) {
            data.busyStart.delete(sessionID)
            const elapsed = (Date.now() - start)
            yield* Metric.update(
              Metric.withAttributes(sessionTotalDuration, {
                sessionID,
              }),
             elapsed / 1000
            )
            // compute wait time from session messages (safe: catch if db not ready)
            let waitTime = 0
            try {
              const msgs = MessageV2.page({ sessionID, limit: 500 })
              for (const m of msgs.items) {
                if (m.info.role !== "assistant") continue
                for (const p of m.parts) {
                  if (p.type === "tool" && (p.tool === "question" || p.tool === "invalid")) {
                    if (p.state.status === "completed" && "time" in p.state && p.state.time?.start && p.state.time?.end) {
                      waitTime += p.state.time.end - p.state.time.start
                    }
                  }
                }
              }
            } catch {
              // db not ready or no messages — waitTime stays 0
            }
            waitTime += getPermissionWaitTotal(sessionID)
            waitTime /= 1000
            const actualTime = Math.max(0, elapsed / 1000 - waitTime)
            yield* Metric.update(
              Metric.withAttributes(sessionWaitDuration, { sessionID }),
              waitTime,
            )
            yield* Metric.update(
              Metric.withAttributes(sessionActualDuration, { sessionID }),
              actualTime,
            )
          }
          // testagent_change end
          yield* status.set(sessionID, { type: "idle", reason })
        }),
        onBusy: Effect.gen(function* () { // testagent_change
          data.busyStart.set(sessionID, Date.now()) // testagent_change
          yield* status.set(sessionID, { type: "busy" }) // testagent_change
        }), // testagent_change
        onInterrupt,
        busy: () => {
          throw new Session.BusyError(sessionID)
        },
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) throw new Session.BusyError(sessionID)
    })

    // testagent_change start - 接收前端传来的 idle reason(user_abort 等)
    // Runner.cancel 内部把 ref 强制改为 Idle 并触发 onIdle,而 onIdle 默认写
    // "completed"。这里在中断前把 reason 写入 per-session 的 idleReason,onIdle
    // 会读取它;未传 reason 的内部取消(workspace warp、子 agent 任务)保持 completed。
    const cancel = Effect.fn("SessionRunState.cancel")(function* (
      sessionID: SessionID,
      reason: IdleReason = "completed",
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing || !existing.busy) {
        yield* status.set(sessionID, { type: "idle", reason })
        return
      }
      data.idleReason.set(sessionID, reason)
      yield* existing.cancel
    })
    // testagent_change end

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(work)
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).startShell(work, ready)
    })

    return Service.of({ assertNotBusy, cancel, ensureRunning, startShell })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SessionStatus.defaultLayer))

export * as SessionRunState from "./run-state"
