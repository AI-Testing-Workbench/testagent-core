import { Effect, Metric } from "effect"
import {
  snapshotEnabled,
  snapshotVcs,
  snapshotTrackDuration,
  snapshotTrackCount,
  snapshotPatchDuration,
  snapshotPatchCount,
  snapshotTotalDuration,
  snapshotMaxDuration,
  snapshotFailed,
} from "@opencode-ai/core/effect/observability"

/**
 * Snapshot 耗时统计（通过 OTLP 指标上报）。
 *
 * 与 `testagent/latency.ts` 完全独立：
 *   - latency 面向"链路日志"（①②③，走 Effect Logger）
 *   - 本模块面向"指标"（走 Metric，独立于 Logger 装配）
 *
 * 覆盖两类信息：
 *   1) 是否开启（vcs 类型 + 配置开关）
 *   2) 每个 session 的 snapshot 总耗时（track / patch 的次数与累计毫秒）
 *
 * 汇总在 session 结束时一次性上报为 Metric。
 * 之所以不用日志：`Effect.logInfo` 只作用于当前 fiber 注册的 Logger，
 * 而项目里 Logger 装配被多处 `Layer.provide` 覆盖，导致 OTLP 日志静默丢失。
 * Metric 走 `PeriodicExportingMetricReader` 全局单例，不受此影响。
 *
 * 开关：环境变量 TESTAGENT_LATENCY=0 可关闭（与 latency 共用）。
 */

const ENABLED = process.env.TESTAGENT_LATENCY !== "0"

type SnapshotStats = {
  sessionID: string
  enabled: boolean
  vcs: string
  trackCount: number
  trackMs: number
  patchCount: number
  patchMs: number
  maxTrackMs: number
  maxPatchMs: number
  failed: number
}

const stats = new Map<string, SnapshotStats>()
/** 开关状态（与 latency 共用 TESTAGENT_LATENCY） */
export function enabled(): boolean {
  return ENABLED
}

/** session 开始时登记开关状态；重复调用保留已有计数 */
export function init(input: { sessionID: string; enabled: boolean; vcs: string }): void {
  if (!ENABLED) return
  const existing = stats.get(input.sessionID)
  if (existing) {
    existing.enabled = input.enabled
    existing.vcs = input.vcs
    return
  }
  stats.set(input.sessionID, {
    sessionID: input.sessionID,
    enabled: input.enabled,
    vcs: input.vcs,
    trackCount: 0,
    trackMs: 0,
    patchCount: 0,
    patchMs: 0,
    maxTrackMs: 0,
    maxPatchMs: 0,
    failed: 0,
  })
}

/** 记录一次 track；`ok=false` 表示 staging 失败 */
export function track(input: { sessionID: string; elapsed: number; ok: boolean }): void {
  if (!ENABLED) return
  const entry = stats.get(input.sessionID)
  if (!entry) return
  entry.trackCount += 1
  entry.trackMs += input.elapsed
  if (input.elapsed > entry.maxTrackMs) entry.maxTrackMs = input.elapsed
  if (!input.ok) entry.failed += 1
}

/** 记录一次 patch */
export function patch(input: { sessionID: string; elapsed: number; files: number }): void {
  if (!ENABLED) return
  const entry = stats.get(input.sessionID)
  if (!entry) return
  entry.patchCount += 1
  entry.patchMs += input.elapsed
  if (input.elapsed > entry.maxPatchMs) entry.maxPatchMs = input.elapsed
}

/**
 * session 结束时汇总上报 Metric。
 *
 * 指标（单位秒，计数类为累加值）：
 *   session.snapshot.enabled          1 = 开启，0 = 关闭
 *   session.snapshot.vcs              1 = git，0 = 其他
 *   session.snapshot.track.duration   track 累计耗时
 *   session.snapshot.track.count      track 次数
 *   session.snapshot.patch.duration   patch 累计耗时
 *   session.snapshot.patch.count      patch 次数
 *   session.snapshot.total.duration   track + patch 总耗时
 *   session.snapshot.max.duration     单次最大耗时
 *   session.snapshot.failed           staging 失败次数
 */
export function report(sessionID: string): Effect.Effect<void> {
  if (!ENABLED) return Effect.void
  const entry = stats.get(sessionID)
  if (!entry) return Effect.void
  // 上报后立即释放，避免长跑进程内存泄漏
  stats.delete(sessionID)

  const attr = { sessionID }
  const total = (entry.trackMs + entry.patchMs) / 1000
  const max = Math.max(entry.maxTrackMs, entry.maxPatchMs) / 1000

  return Effect.all(
    [
      Metric.update(Metric.withAttributes(snapshotEnabled, attr), entry.enabled ? 1 : 0),
      Metric.update(Metric.withAttributes(snapshotVcs, attr), entry.vcs === "git" ? 1 : 0),
      Metric.update(Metric.withAttributes(snapshotTrackDuration, attr), entry.trackMs / 1000),
      Metric.update(Metric.withAttributes(snapshotTrackCount, attr), entry.trackCount),
      Metric.update(Metric.withAttributes(snapshotPatchDuration, attr), entry.patchMs / 1000),
      Metric.update(Metric.withAttributes(snapshotPatchCount, attr), entry.patchCount),
      Metric.update(Metric.withAttributes(snapshotTotalDuration, attr), total),
      Metric.update(Metric.withAttributes(snapshotMaxDuration, attr), max),
      Metric.update(Metric.withAttributes(snapshotFailed, attr), entry.failed),
    ],
    { discard: true },
  )
}

/** 读取当前统计（调试用） */
export function peek(sessionID: string): SnapshotStats | undefined {
  return stats.get(sessionID)
}
