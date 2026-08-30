/**
 * OpenCode Langfuse Plugin (v3.x API) - Direct API Ingestion Mode
 * Traces agent execution to Langfuse for observability
 *
 * Features:
 * - Batch upload: Collects all trace data (trace/generation/span) and uploads together
 * - Data integrity: Ensures complete trace with all nested observations
 * - Direct ingestion API: Bypasses Langfuse SDK, directly calls /api/public/ingestion
 * - Fallback mechanism: Uploads existing data on session error
 * - Trace creation for each session using unique UUID
 * - LLM generation tracking with full message context
 * - Tool span recording with proper parent-child relationships
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { Effect, Schema } from "effect"
import { User } from "@/testagent/user"
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "fs"
import { readdir, unlink } from "fs/promises"
import { dirname, join, resolve } from "path"
import { homedir } from "os"

// const LANGFUSE_BASE_URL = "https://testhub-agent-trace-dev.paas.cmbchina.cn";

const LANGFUSE_BASE_URL = decodeURIComponent(
  atob("aHR0cCUzQSUyRiUyRnRlc3RodWItYWdlbnQtdHJhY2UucGFhc3VhdC5jbWJjaGluYS5jbg=="),
)
const VERSION = "1.0.4"
const TESTAGENT_VERSION = "1.5.0"
const LANGFUSE_FETCH_TIMEOUT_MS = 10_000
const LANGFUSE_KEY_LOOKUP_TIMEOUT_MS = 15000
const TESTAGENT_DATA_DIR = join(homedir(), ".local", "share", "testagent")
const LANGFUSE_KEY_CACHE_FILE = join(TESTAGENT_DATA_DIR, "langfuse-project-keys.json")
const MAX_INGESTION_BATCH_BYTES = 900 * 1024
const MAX_OBSERVED_TEXT_LENGTH = 10000
const MAX_ERROR_DETAIL_LENGTH = 2000
const PLUGIN_RUNTIME_ID = generateUUID()
const MAX_DIAGNOSTIC_BATCH_EVENT_IDS = 50
const MAX_DIAGNOSTIC_TAG_VALUE_LENGTH = 4000

let baseMetadata: () => Record<string, string>
let currentPluginInstanceId = "uninitialized"

// ==================== 会话管理 ====================

let currentSessionId: string | null = null
let rootSessionId: string | null = null // 主session ID
const sessionToTrace = new Map<string, string>() // sessionId -> traceId
const sessionToAgentSpan = new Map<string, string>() // subagent session -> agent span id
const pendingSubagents = new Map<string, { traceId: string; agentSpanId: string }[]>() // parent session -> pending subagents
const generatedTraceIds = new Set<string>() // trace ids generated as fallback before opencode messageID is available
const idleSessionIds = new Set<string>() // sessions that have emitted session.idle and must not keep a trace open
const createdSessionIds = new Set<string>()
const sessionCreatedWaiters = new Map<string, (() => void)[]>()
let sessionParentResolver: ((sessionId: string) => Promise<string | undefined>) | undefined
// This wait is only used for a session whose creation event has not arrived;
// it is intentionally per-session so concurrent top-level conversations are
// never serialized. Child-session creation can lag hook callbacks noticeably.
const SESSION_CREATED_WAIT_MS = 1000
// Plugin events may be delivered out of order: session.idle can arrive just
// before the final step-finish event that contains usage and finish reason.
const SESSION_IDLE_FINALIZATION_WAIT_MS = 1000
// Let out-of-order part snapshots settle after step-finish without waiting for
// the whole session/trace. The timer is reset by every late text/reasoning part.
const OBSERVATION_COMPLETION_QUIET_MS = 250
// Completion IDs are short-lived deduplication tombstones. Normal trace
// cleanup removes them immediately; these limits protect against traces that
// never reach session.idle because of a crash or missing lifecycle event.
const COMPLETED_OBSERVATION_STATE_TTL_MS = 6 * 60 * 60 * 1000
const COMPLETED_OBSERVATION_STATE_MONITOR_INTERVAL_MS = 60 * 1000
const MAX_COMPLETED_OBSERVATIONS_PER_TRACE = 10_000
const MAX_COMPLETED_OBSERVATIONS_TOTAL = 50_000
const MAX_COMPLETED_OBSERVATION_TRACES = 1_000
const pendingIdleFinalizations = new Set<string>()

function generateSessionId(): string {
  return generateUUID()
}

const sessionIdMap = new Map<string, string>()

function getSessionId(inputSessionId?: string): string {
  if (inputSessionId) {
    currentSessionId = inputSessionId
    sessionIdMap.set(inputSessionId, inputSessionId)
  } else if (!currentSessionId) {
    currentSessionId = generateSessionId()
  }
  return currentSessionId
}

// ==================== 批量数据结构定义 ====================

/**
 * 批量上传的 Trace 数据结构
 */
interface TraceBatch {
  id: string
  name: string
  sessionId: string
  input: string
  output?: string
  tags: string[]
  metadata: Record<string, any>
  generations: GenerationData[]
  spans: SpanData[]
}

/**
 * Generation 数据结构
 */
interface GenerationData {
  id: string
  traceId: string
  parentObservationId?: string
  name: string
  model: string
  modelParameters: Record<string, any>
  input: any
  output?: any
  startTime: string
  endTime?: string
  completionStartTime?: string
  usage?: { input: number; output: number; total: number }
  metadata: Record<string, any>
  tags: string[]
}

/**
 * Span 数据结构
 */
interface SpanData {
  id: string
  traceId: string
  parentObservationId?: string
  name: string
  input: any
  output?: any
  startTime: string
  endTime?: string
  metadata: Record<string, any>
  tags: string[]
  level?: string
}

/**
 * GenInfo - 运行时 generation 跟踪
 */
interface GenInfo {
  traceId: string
  genId: string
  sessionId: string
  parentObservationId?: string
  selectedModel?: string
  apiId?: string
  resolvedModel: string
  modelName: string
  startTime: Date
  completionStartTime: Date | null
  // The response can end before the late step-finish event that carries usage.
  // Keep that boundary so finalization never stretches it to session.idle.
  responseEndTime: Date | null
  stepNumber: number
  output: string
  parts: string[]
  // OpenCode emits text/reasoning as mutable message parts. Keep the latest
  // value per part instead of appending every message.part.updated snapshot.
  textPartSnapshots: Map<string, GenerationTextPartSnapshot>
  textPartSequence: number
  toolCalls: Array<{ toolCallId: string; name: string; args: any }>
  toolResults?: Array<{ toolCallId: string; name: string; output: string; index: number; args: any; metadata?: any }>
  isSkillChild: boolean
  hasUsage: boolean
  finalOutput: { text: string; tool_calls?: any[]; usage?: any; finish_reason?: string } | null
  assistantMessageId?: string
  modelParameters: Record<string, any>
  input: any
  generationData: GenerationData
  pendingSequence: number
}

interface GenerationTextPartSnapshot {
  partId: string
  type: "text" | "reasoning" | "unknown"
  text: string
  sequence: number
  complete: boolean
}

/**
 * Skill 上下文接口
 */
interface SkillContext {
  spanId: string
  traceId: string
  gens: GenInfo[]
  parentSpanId?: string
  isSubagent: boolean
}

interface SkillInfo {
  skillName: string
  skillId?: string
  skillSpanId: string
}

type ToolResultSnapshot = {
  output: any
  metadata?: any
  title?: string
  completedAt?: Date
  toolStatus?: string
  toolPartCompleted?: boolean
  toolCompletionSource?: string
}

// ==================== 全局状态管理 ====================

// 批量上传数据存储: traceId -> TraceBatch
const traceBatches = new Map<string, TraceBatch>()

// 存储每个 trace 的 generation 列表
const gens = new Map<string, GenInfo[]>()

// 存储工具调用的 Span ID
const toolSpanIds = new Map<string, string>()
const toolCallInfos = new Map<string, { spanId: string; traceId: string; sessionId: string; toolName?: string }>()
const sessionSpanIds = new Map<string, Set<string>>()
const traceSkillInfos = new Map<string, SkillInfo[]>()
const observationSkillInfoCounts = new Map<string, number>()
// Fallback grouping parent for hooks that arrive before their session has been
// associated. The session-scoped context below remains the primary source so
// concurrent sessions on the same trace cannot overwrite one another.
const activeSkillSpanByTrace = new Map<string, string>()
const pendingSkillSpans = new Map<string, SpanData>()

// 工具结果有时先出现在 message.part.updated，随后 tool.execute.after 的 output 仍为 null。
// 按 callID 缓存已完成结果，用来回填同一个 TOOL span。
const toolResultSnapshots = new Map<string, ToolResultSnapshot>()

// The most recently invoked skill remains the grouping parent for its session
// until another skill replaces it. Keep this session-scoped: a trace-wide slot
// would leak ownership between concurrent sessions.
const activeSkillContexts = new Map<string, { callID: string; context: SkillContext }>()

// 全局 generation 列表
const allGenerations: GenInfo[] = []

// 当前活跃的 generation 队列（按 session 维护，避免主/子 agent 相互覆盖，也避免多 step 事件交错互相覆盖）
const activeGenerations = new Map<string, GenInfo[]>()
// chat.params has no assistant message ID and may be invoked for a request that
// never produces a streamed response. Keep it pending until a concrete message
// part proves that the LLM call exists.
const pendingGenerations = new Map<string, GenInfo[]>()
let pendingGenerationSequence = 0

// 记录用户在消息阶段选择的模型，避免网关降级后丢失原始选择
const selectedModelsBySession = new Map<string, string>()

// 当前活跃的 Trace ID
let currentTraceId: string | null = null

// 已经发起过 trace-create 的 trace，避免多轮 chat.message 重复创建同一条 trace。
const uploadedTraceIds = new Set<string>()

// 数据上报失败后只保留在当前进程内存中；服务重启后不恢复历史失败数据。
const failedIngestionEvents: any[] = []
let retryingFailedIngestionEvents = false
// const oversizedIngestionObservationKeys = new Set<string>()
const MAX_FAILED_INGESTION_EVENTS = 500
const MAX_FAILED_INGESTION_QUEUE_BYTES = 5 * 1024 * 1024
const FAILED_INGESTION_RETRY_BASE_DELAY_MS = 1000
const FAILED_INGESTION_RETRY_MAX_DELAY_MS = 60_000
const MAX_FAILED_INGESTION_RETRY_ATTEMPTS = 3
const BACKGROUND_BATCHES_BEFORE_FAILED_RETRY = 10
const TRACE_UPSERT_DEBOUNCE_MS = 250
const FLUSH_BACKGROUND_UPLOAD_TIMEOUT_MS = 1000
const INGESTION_FAILURE_LOG_INTERVAL_MS = 60_000
let handlersInstalled = false // testagent_change
const BACKGROUND_INGESTION_BATCH_SIZE = 50
const FAILED_INGESTION_RETRY_BATCH_SIZE = 50
const FAILED_INGESTION_RETRY_ENABLED = true
const MAX_BACKGROUND_INGESTION_EVENTS = 10000
const MAX_BACKGROUND_INGESTION_BYTES = 5 * 1024 * 1024
let backgroundIngestionEvents: any[] = []
let backgroundIngestionHead = 0
let backgroundIngestionBytes = 0
let backgroundIngestionDrainPromise: Promise<void> | null = null
let backgroundIngestionDrainScheduled = false
let backgroundIngestionDrainTimer: ReturnType<typeof setTimeout> | null = null
let backgroundIngestionDrainScheduledAt = 0
let failedIngestionQueueBytes = 0
let failedIngestionRetryAttempt = 0
let failedIngestionNextRetryAt = 0
let backgroundBatchesSinceFailedRetry = 0
let lastIngestionFailureLogAt = 0
let lastFailedIngestionQueueDropLogAt = 0
const pendingTraceUpserts = new Map<string, TraceBatch>()
const lastEnqueuedTraceSnapshots = new Map<string, string>()
let traceUpsertTimer: ReturnType<typeof setTimeout> | null = null
const pendingBackgroundUpdateEvents = new Map<string, number>()
const failedIngestionUpdateEventIds = new Map<string, Set<string>>()
const ingestionEventByteLengths = new WeakMap<object, number>()
const completedObservationIdsByTrace = new Map<string, Set<string>>()
const completedObservationTraceTouchedAt = new Map<string, number>()
let completedObservationIdCount = 0
let completedObservationStateMonitorTimer: ReturnType<typeof setInterval> | null = null
const pendingCompletedObservationEvictions = {
  capacity: { observationCount: 0, traceCount: 0 },
  timeout: { observationCount: 0, traceCount: 0 },
}
const generationCompletionTimers = new Map<string, ReturnType<typeof setTimeout>>()
let shutdownFlushPromise: Promise<void> | null = null
let shutdownFlushCompleted = false

function reportCompletedObservationState() {
  const tags = {
    type: "observationCompletionDedup",
    reason: "periodic",
  }
  trackEvent("metric", {
    metricName: "plugin.langfuse.observation_completion.dedup.observation_count",
    metricValue: completedObservationIdCount,
    tags,
  })
  trackEvent("metric", {
    metricName: "plugin.langfuse.observation_completion.dedup.trace_count",
    metricValue: completedObservationIdsByTrace.size,
    tags,
  })
}

function recordCompletedObservationStateEviction(
  reason: "capacity" | "timeout",
  observationCount: number,
  traceCount: number,
) {
  if (observationCount <= 0 && traceCount <= 0) return
  pendingCompletedObservationEvictions[reason].observationCount += observationCount
  pendingCompletedObservationEvictions[reason].traceCount += traceCount
}

function flushCompletedObservationStateEvictionLog() {
  const capacity = { ...pendingCompletedObservationEvictions.capacity }
  const timeout = { ...pendingCompletedObservationEvictions.timeout }
  const observationCount = capacity.observationCount + timeout.observationCount
  const traceCount = capacity.traceCount + timeout.traceCount
  if (observationCount <= 0 && traceCount <= 0) return

  pendingCompletedObservationEvictions.capacity.observationCount = 0
  pendingCompletedObservationEvictions.capacity.traceCount = 0
  pendingCompletedObservationEvictions.timeout.observationCount = 0
  pendingCompletedObservationEvictions.timeout.traceCount = 0
  // Capacity/timeout cleanup can happen repeatedly on an abnormal long-lived
  // trace. Aggregate it into at most one log per monitor interval and do not
  // turn internal dedup housekeeping into high-volume telemetry.
  trackEvent("log", {
    level: "warn",
    message: "聚合清理 observation 完成去重状态",
    data: {
      observationCount,
      traceCount,
      capacity,
      timeout,
      remainingObservationCount: completedObservationIdCount,
      remainingTraceCount: completedObservationIdsByTrace.size,
    },
  })
}

function clearCompletedObservationTrace(traceId: string) {
  const observationIds = completedObservationIdsByTrace.get(traceId)
  if (!observationIds) {
    completedObservationTraceTouchedAt.delete(traceId)
    return 0
  }

  const removedCount = observationIds.size
  completedObservationIdsByTrace.delete(traceId)
  completedObservationTraceTouchedAt.delete(traceId)
  completedObservationIdCount = Math.max(0, completedObservationIdCount - removedCount)
  return removedCount
}

function hasCompletedObservation(traceId: string, observationId: string) {
  const observationIds = completedObservationIdsByTrace.get(traceId)
  if (!observationIds?.has(observationId)) return false
  completedObservationTraceTouchedAt.set(traceId, Date.now())
  return true
}

function enforceCompletedObservationStateLimits(currentTraceId: string) {
  let evictedObservationCount = 0
  let evictedTraceCount = 0
  const currentTraceObservationIds = completedObservationIdsByTrace.get(currentTraceId)
  while (currentTraceObservationIds && currentTraceObservationIds.size > MAX_COMPLETED_OBSERVATIONS_PER_TRACE) {
    const oldestObservationId = currentTraceObservationIds.values().next().value as string | undefined
    if (!oldestObservationId) break
    currentTraceObservationIds.delete(oldestObservationId)
    completedObservationIdCount = Math.max(0, completedObservationIdCount - 1)
    evictedObservationCount += 1
  }

  if (
    completedObservationIdCount > MAX_COMPLETED_OBSERVATIONS_TOTAL ||
    completedObservationIdsByTrace.size > MAX_COMPLETED_OBSERVATION_TRACES
  ) {
    const tracesByAge = [...completedObservationIdsByTrace.keys()].sort(
      (left, right) =>
        (completedObservationTraceTouchedAt.get(left) ?? 0) -
        (completedObservationTraceTouchedAt.get(right) ?? 0),
    )
    for (const traceId of tracesByAge) {
      if (
        completedObservationIdCount <= MAX_COMPLETED_OBSERVATIONS_TOTAL &&
        completedObservationIdsByTrace.size <= MAX_COMPLETED_OBSERVATION_TRACES
      ) {
        break
      }
      const removedCount = clearCompletedObservationTrace(traceId)
      if (removedCount > 0) {
        evictedObservationCount += removedCount
        evictedTraceCount += 1
      }
    }
  }

  recordCompletedObservationStateEviction("capacity", evictedObservationCount, evictedTraceCount)
}

function markCompletedObservation(traceId: string, observationId: string) {
  let observationIds = completedObservationIdsByTrace.get(traceId)
  if (!observationIds) {
    observationIds = new Set<string>()
    completedObservationIdsByTrace.set(traceId, observationIds)
  }
  if (observationIds.has(observationId)) {
    completedObservationTraceTouchedAt.set(traceId, Date.now())
    return false
  }

  observationIds.add(observationId)
  completedObservationTraceTouchedAt.set(traceId, Date.now())
  completedObservationIdCount += 1
  enforceCompletedObservationStateLimits(traceId)
  return observationIds.has(observationId)
}

function sweepCompletedObservationState(now = Date.now()) {
  let evictedObservationCount = 0
  let evictedTraceCount = 0
  for (const [traceId, touchedAt] of [...completedObservationTraceTouchedAt]) {
    if (now - touchedAt < COMPLETED_OBSERVATION_STATE_TTL_MS) continue
    const removedCount = clearCompletedObservationTrace(traceId)
    if (removedCount > 0) {
      evictedObservationCount += removedCount
      evictedTraceCount += 1
    }
  }
  recordCompletedObservationStateEviction("timeout", evictedObservationCount, evictedTraceCount)
  flushCompletedObservationStateEvictionLog()
  reportCompletedObservationState()
}

function startCompletedObservationStateMonitor() {
  if (completedObservationStateMonitorTimer) clearInterval(completedObservationStateMonitorTimer)
  completedObservationStateMonitorTimer = setInterval(
    sweepCompletedObservationState,
    COMPLETED_OBSERVATION_STATE_MONITOR_INTERVAL_MS,
  )
  completedObservationStateMonitorTimer.unref?.()
  sweepCompletedObservationState()
}

function stopCompletedObservationStateMonitor() {
  if (!completedObservationStateMonitorTimer) return
  clearInterval(completedObservationStateMonitorTimer)
  completedObservationStateMonitorTimer = null
}

function clearAllCompletedObservationState() {
  completedObservationIdsByTrace.clear()
  completedObservationTraceTouchedAt.clear()
  completedObservationIdCount = 0
  pendingCompletedObservationEvictions.capacity.observationCount = 0
  pendingCompletedObservationEvictions.capacity.traceCount = 0
  pendingCompletedObservationEvictions.timeout.observationCount = 0
  pendingCompletedObservationEvictions.timeout.traceCount = 0
}

function migrateCompletedObservationState(oldTraceId: string, newTraceId: string) {
  if (oldTraceId === newTraceId) return
  const oldObservationIds = completedObservationIdsByTrace.get(oldTraceId)
  if (!oldObservationIds) return

  const targetObservationIds = completedObservationIdsByTrace.get(newTraceId) ?? new Set<string>()
  const targetSizeBefore = targetObservationIds.size
  for (const observationId of oldObservationIds) targetObservationIds.add(observationId)
  completedObservationIdsByTrace.set(newTraceId, targetObservationIds)
  completedObservationIdsByTrace.delete(oldTraceId)
  completedObservationIdCount -= oldObservationIds.size
  completedObservationIdCount += targetObservationIds.size - targetSizeBefore
  completedObservationIdCount = Math.max(0, completedObservationIdCount)
  completedObservationTraceTouchedAt.set(
    newTraceId,
    Math.max(
      completedObservationTraceTouchedAt.get(oldTraceId) ?? 0,
      completedObservationTraceTouchedAt.get(newTraceId) ?? 0,
      Date.now(),
    ),
  )
  completedObservationTraceTouchedAt.delete(oldTraceId)
  enforceCompletedObservationStateLimits(newTraceId)
}

function getCurrentSkillContext(sessionId?: string, traceId?: string): SkillContext | null {
  if (!sessionId) return null
  const entry = activeSkillContexts.get(sessionId)
  if (!entry || (traceId && entry.context.traceId !== traceId)) return null
  return entry.context
}

function appendTraceSkillInfo(traceId: string, skillInfo: SkillInfo) {
  const existing = traceSkillInfos.get(traceId) ?? []
  traceSkillInfos.set(traceId, [...existing, skillInfo])
}

function updateTraceSkillInfo(traceId: string, skillSpanId: string, updates: { skillName?: string; skillId?: string }) {
  const existing = traceSkillInfos.get(traceId)
  if (!existing) return

  const idx = existing.findIndex((item) => item.skillSpanId === skillSpanId)
  if (idx === -1) return

  const next = [...existing]
  next[idx] = {
    ...next[idx],
    ...(updates.skillName ? { skillName: updates.skillName } : {}),
    ...(updates.skillId ? { skillId: updates.skillId } : {}),
  }
  traceSkillInfos.set(traceId, next)
}

function getTraceSkillInfo(traceId: string, count?: number): SkillInfo[] | undefined {
  const allSkillInfo = traceSkillInfos.get(traceId)
  const skillInfo = count === undefined ? allSkillInfo : allSkillInfo?.slice(0, count)
  return skillInfo && skillInfo.length > 0
    ? skillInfo.map((item) => ({
        skillName: item.skillName,
        ...(item.skillId ? { skillId: item.skillId } : {}),
        skillSpanId: item.skillSpanId,
      }))
    : undefined
}

function withTraceSkillInfo(traceId: string, metadata: Record<string, any> = {}) {
  const skillInfo = getTraceSkillInfo(traceId)
  return skillInfo ? { ...metadata, skillInfo } : metadata
}

function observationSkillInfoKey(traceId: string, observationId: string) {
  return `${traceId}:${observationId}`
}

function rememberObservationSkillInfoCount(traceId: string, observationId: string) {
  observationSkillInfoCounts.set(observationSkillInfoKey(traceId, observationId), traceSkillInfos.get(traceId)?.length ?? 0)
}

function withoutSkillInfo(metadata: Record<string, any> = {}) {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, "skillInfo")) return metadata
  const { skillInfo: _skillInfo, ...rest } = metadata
  return rest
}

function withoutObservationCompletionFields(metadata: Record<string, any> = {}) {
  const {
    finish_reason: _finishReason,
    toolPartCompleted: _toolPartCompleted,
    toolAfterReceived: _toolAfterReceived,
    toolCompletionSource: _toolCompletionSource,
    agentCompleted: _agentCompleted,
    agentCompletionSource: _agentCompletionSource,
    observationCompleted: _observationCompleted,
    observationCompletionSource: _observationCompletionSource,
    observationCompletionStatus: _observationCompletionStatus,
    observationCompletedAt: _observationCompletedAt,
    ...rest
  } = metadata || {}
  return rest
}

function getObservationSubagentType(traceId: string, observationId: string): string | undefined {
  const batch = traceBatches.get(traceId)
  const observation =
    batch?.generations.find((generation) => generation.id === observationId) ??
    batch?.spans.find((span) => span.id === observationId)
  const subagentType = observation?.metadata?.subagent_type
  return typeof subagentType === "string" && subagentType.trim() ? subagentType : undefined
}

function withTraceSkillInfoForObservationUpdate(
  traceId: string,
  observationId: string,
  metadata: Record<string, any> = {},
) {
  // LLM/tool updates often replace the whole metadata object. Once a node has
  // been associated with a subagent, keep that ownership marker on every later
  // partial/final update, including the completion snapshot.
  const existingSubagentType = getObservationSubagentType(traceId, observationId)
  const metadataWithSubagentType =
    metadata.subagent_type === undefined && existingSubagentType
      ? { ...metadata, subagent_type: existingSubagentType }
      : metadata
  const count = observationSkillInfoCounts.get(observationSkillInfoKey(traceId, observationId))
  const skillInfo = count === undefined ? undefined : getTraceSkillInfo(traceId, count)
  return skillInfo && skillInfo.length > 0
    ? { ...metadataWithSubagentType, skillInfo }
    : withoutSkillInfo(metadataWithSubagentType)
}

function getLatestActiveGeneration(sessionId: string): GenInfo | undefined {
  const active = activeGenerations.get(sessionId)
  return active?.[active.length - 1]
}

function getNextFinishingGeneration(sessionId: string): GenInfo | undefined {
  const active = activeGenerations.get(sessionId)
  return active?.find((g) => !g.finalOutput) ?? active?.[0]
}

function getTextPartId(part: any): string | undefined {
  const partId = part?.id ?? part?.partID
  return typeof partId === "string" && partId ? partId : undefined
}

function findGenerationForTextPart(sessionId: string, partId?: string): GenInfo | undefined {
  if (!partId) return undefined

  const active = activeGenerations.get(sessionId) ?? []
  const activeMatch = [...active].reverse().find((g) => g.textPartSnapshots.has(partId))
  if (activeMatch) return activeMatch

  // A final part snapshot can be delivered after step-finish. Retain the
  // ownership established by the initial part event so that late text can
  // repair the completed generation without losing its usage data.
  return [...allGenerations]
    .reverse()
    .find((g) => g.sessionId === sessionId && g.textPartSnapshots.has(partId))
}

function getActiveGenerationForPart(sessionId: string, part: any): GenInfo | undefined {
  const active = activeGenerations.get(sessionId)
  const messageId = part?.messageID

  if (messageId && active?.length) {
    const matching = active.find((g) => g.assistantMessageId === messageId)
    if (matching) return matching

    const unbound =
      part.type === "step-finish"
        ? active.find((g) => !g.assistantMessageId && !g.finalOutput)
        : [...active].reverse().find((g) => !g.assistantMessageId && !g.finalOutput)
    if (unbound) {
      unbound.assistantMessageId = messageId
      return unbound
    }

    // A part with an assistant message ID must never be assigned to a
    // generation belonging to another assistant message.
    return undefined
  }

  return part.type === "step-finish" ? getNextFinishingGeneration(sessionId) : getLatestActiveGeneration(sessionId)
}

function isGenerationPart(part: any) {
  if (["step-start", "step-finish", "text", "reasoning"].includes(part?.type)) return true
  // A running tool proves the LLM step exists. A completed tool can be a late
  // event from a prior assistant message and must not activate a new request.
  return part?.type === "tool" && part.state?.status === "running"
}

function activatePendingGeneration(
  sessionId: string,
  messageId?: string,
  options?: { preferLatest?: boolean; startTime?: Date },
): GenInfo | undefined {
  const pending = pendingGenerations.get(sessionId)
  const gen = options?.preferLatest ? pending?.pop() : pending?.shift()
  if (!gen) return undefined
  if (pending.length === 0) pendingGenerations.delete(sessionId)

  // chat.params can be delivered ahead of preceding tool hooks. Do not retain
  // its arrival time as the observation boundary: use the first concrete
  // generation event (or a caller-provided fallback) immediately before the
  // generation-create event is emitted.
  const startTime = options?.startTime ?? new Date()
  gen.startTime = startTime
  gen.generationData.startTime = startTime.toISOString()

  // chat.params only creates a pending candidate. A skill hook can be
  // delivered after that callback but before this first concrete response
  // part creates the generation. Bind to the skill that is active *now*, not
  // to a stale skill parent captured by chat.params (notably for skill #2).
  const currentSkill = getCurrentSkillContext(sessionId, gen.traceId)
  const parentObservationId = currentSkill?.spanId ?? (!gen.parentObservationId ? getSessionObservationParent(sessionId) : undefined)
  if (parentObservationId && parentObservationId !== gen.parentObservationId) {
    gen.parentObservationId = parentObservationId
    gen.generationData.parentObservationId = parentObservationId
  }
  if (currentSkill) {
    gen.isSkillChild = true
  }
  const subagentType = getSessionSubagentType(sessionId, gen.traceId)
  if (subagentType && gen.generationData.metadata.subagent_type !== subagentType) {
    gen.generationData.metadata = {
      ...gen.generationData.metadata,
      subagent_type: subagentType,
    }
  }

  if (messageId) gen.assistantMessageId = messageId
  // chat.params is not a reliable request-snapshot boundary on every
  // OpenCode/TestAgent version. In some versions the messages transform hook
  // for this request is delivered just after chat.params, which otherwise
  // leaves every generation with the preceding request's history. The first
  // concrete response part/tool hook is the earliest boundary at which the
  // request is known to have started and its transformed messages are stable.
  refreshGenerationInputFromCachedMessages(gen)
  addGenerationToBatch(gen.traceId, gen.generationData)
  createGenerationImmediately(gen.generationData)

  const genList = gens.get(gen.traceId) || []
  genList.push(gen)
  gens.set(gen.traceId, genList)
  allGenerations.push(gen)
  addActiveGeneration(sessionId, gen)
  return gen
}

function getOrActivateGenerationForPart(
  sessionId: string,
  part: any,
  eventTime?: any,
  options?: { allowCompletedMessageReuse?: boolean },
): GenInfo | undefined {
  const ownedGeneration = findGenerationForTextPart(sessionId, getTextPartId(part))
  if (ownedGeneration) return ownedGeneration

  const active = getActiveGenerationForPart(sessionId, part)
  if (active || !isGenerationPart(part)) return active

  // Never let a delayed part from a completed assistant message create or bind
  // the next pending LLM generation.
  if (
    !options?.allowCompletedMessageReuse &&
    part?.messageID &&
    allGenerations.some(
      (gen) => gen.sessionId === sessionId && gen.assistantMessageId === part.messageID && !!gen.finalOutput,
    )
  ) {
    return undefined
  }
  const startTime = getPartTimestamp(part, "start") ?? getEventTimestamp(eventTime) ?? new Date()
  return activatePendingGeneration(sessionId, part?.messageID, { startTime })
}

function addActiveGeneration(sessionId: string, gen: GenInfo) {
  const active = activeGenerations.get(sessionId) ?? []
  active.push(gen)
  activeGenerations.set(sessionId, active)
}

function deleteActiveGeneration(sessionId: string, gen: GenInfo) {
  const active = activeGenerations.get(sessionId)
  if (!active) return

  const remaining = active.filter((item) => item.genId !== gen.genId)
  if (remaining.length === 0) activeGenerations.delete(sessionId)
  else activeGenerations.set(sessionId, remaining)
}

function markGenerationCompletionStarted(g: GenInfo, completionStartTime = new Date()) {
  if (g.completionStartTime) return

  g.completionStartTime = completionStartTime
  const generationUpdates = { completionStartTime: g.completionStartTime.toISOString() }
  updateGenerationInBatch(g.traceId, g.genId, generationUpdates)
  updateGenerationImmediately(g.traceId, g.genId, generationUpdates)
}

function getEventTimestamp(value: any): Date | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : undefined

  if (typeof value === "string") {
    const numeric = Number(value)
    if (value.trim() !== "" && Number.isFinite(numeric)) return getEventTimestamp(numeric)
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime()) ? parsed : undefined
  }

  if (typeof value !== "number" || !Number.isFinite(value)) return undefined

  // OpenCode emits epoch milliseconds; accept seconds and high-resolution
  // values too so older event payloads remain compatible.
  const milliseconds =
    Math.abs(value) < 1e11 ? value * 1000 : Math.abs(value) > 1e17 ? value / 1e6 : Math.abs(value) > 1e14 ? value / 1e3 : value
  const parsed = new Date(milliseconds)
  return Number.isFinite(parsed.getTime()) ? parsed : undefined
}

function getPartTimestamp(part: any, kind: "start" | "end"): Date | undefined {
  const candidates = [
    part?.state?.time?.[kind],
    part?.time?.[kind],
    part?.info?.time?.[kind],
    part?.metadata?.time?.[kind],
    part?.[`${kind}Time`],
    part?.[`${kind}At`],
  ]
  for (const candidate of candidates) {
    const timestamp = getEventTimestamp(candidate)
    if (timestamp) return timestamp
  }
  return undefined
}

function markGenerationResponseFinished(g: GenInfo, endTime = new Date()) {
  if (g.responseEndTime) return

  g.responseEndTime = endTime
  const generationUpdates: Partial<GenerationData> = { endTime: endTime.toISOString() }
  updateGenerationInBatch(g.traceId, g.genId, generationUpdates)
  updateGenerationImmediately(g.traceId, g.genId, generationUpdates)
}

function normalizeModelSelection(model: any): string | undefined {
  if (!model) return undefined
  if (typeof model === "string") return model

  const providerId = model.providerID || model.provider?.id || model.provider
  const modelId = model.id || model.modelID || model.name

  if (providerId && modelId) return `${providerId}/${modelId}`
  if (modelId) return String(modelId)
  return undefined
}

function buildLLMModelMetadata(
  g: Pick<GenInfo, "modelName" | "modelParameters" | "selectedModel" | "resolvedModel" | "apiId">,
) {
  return {
    name: g.modelName,
    provider: g.modelName.split("/")[0],
    id: g.modelName.split("/")[1],
    parameters: g.modelParameters,
    apiId: g.apiId,
    selectedModel: g.selectedModel,
    resolvedModel: g.resolvedModel,
  }
}

function migrateTraceId(oldTraceId: string, newTraceId: string) {
  if (oldTraceId === newTraceId) return

  migrateQueuedIngestionTraceId(oldTraceId, newTraceId)
  migrateCompletedObservationState(oldTraceId, newTraceId)

  const batch = traceBatches.get(oldTraceId)
  if (batch) {
    const targetBatch = traceBatches.get(newTraceId)
    if (targetBatch) {
      if (!targetBatch.input && batch.input) targetBatch.input = batch.input
      if (!targetBatch.output && batch.output) targetBatch.output = batch.output
      for (const gen of batch.generations) {
        gen.traceId = newTraceId
        if (!targetBatch.generations.some((existing) => existing.id === gen.id)) targetBatch.generations.push(gen)
      }
      for (const span of batch.spans) {
        span.traceId = newTraceId
        if (!targetBatch.spans.some((existing) => existing.id === span.id)) targetBatch.spans.push(span)
      }
    } else {
      batch.id = newTraceId
      for (const gen of batch.generations) gen.traceId = newTraceId
      for (const span of batch.spans) span.traceId = newTraceId
      traceBatches.set(newTraceId, batch)
    }
    traceBatches.delete(oldTraceId)
  }

  const genList = gens.get(oldTraceId)
  if (genList) {
    for (const gen of genList) gen.traceId = newTraceId
    const targetGenList = gens.get(newTraceId)
    gens.delete(oldTraceId)
    gens.set(newTraceId, targetGenList ? [...targetGenList, ...genList] : genList)
  }

  const genIndex = currentGenIdx.get(oldTraceId)
  if (genIndex !== undefined) {
    currentGenIdx.delete(oldTraceId)
    currentGenIdx.set(newTraceId, genIndex)
  }

  const skillInfo = traceSkillInfos.get(oldTraceId)
  if (skillInfo) {
    const targetSkillInfo = traceSkillInfos.get(newTraceId)
    traceSkillInfos.delete(oldTraceId)
    traceSkillInfos.set(newTraceId, targetSkillInfo ? [...targetSkillInfo, ...skillInfo] : skillInfo)
  }

  const activeSkillSpanId = activeSkillSpanByTrace.get(oldTraceId)
  if (activeSkillSpanId) {
    activeSkillSpanByTrace.delete(oldTraceId)
    if (!activeSkillSpanByTrace.has(newTraceId)) activeSkillSpanByTrace.set(newTraceId, activeSkillSpanId)
  }

  for (const [key, skillInfoCount] of [...observationSkillInfoCounts]) {
    if (!key.startsWith(`${oldTraceId}:`)) continue
    observationSkillInfoCounts.delete(key)
    observationSkillInfoCounts.set(`${newTraceId}:${key.slice(oldTraceId.length + 1)}`, skillInfoCount)
  }

  for (const gen of allGenerations) {
    if (gen.traceId === oldTraceId) gen.traceId = newTraceId
  }
  for (const active of activeGenerations.values()) {
    for (const gen of active) {
      if (gen.traceId === oldTraceId) {
        gen.traceId = newTraceId
        gen.generationData.traceId = newTraceId
      }
    }
  }
  for (const pending of pendingGenerations.values()) {
    for (const gen of pending) {
      if (gen.traceId === oldTraceId) {
        gen.traceId = newTraceId
        gen.generationData.traceId = newTraceId
      }
    }
  }
  for (const entry of activeSkillContexts.values()) {
    if (entry.context.traceId === oldTraceId) entry.context.traceId = newTraceId
  }
  for (const [parentSessionId, pending] of pendingSubagents) {
    pendingSubagents.set(
      parentSessionId,
      pending.map((entry) => (entry.traceId === oldTraceId ? { ...entry, traceId: newTraceId } : entry)),
    )
  }
  for (const [sid, traceId] of sessionToTrace) {
    if (traceId === oldTraceId) sessionToTrace.set(sid, newTraceId)
  }
  for (const [callID, info] of toolCallInfos) {
    if (info.traceId === oldTraceId) toolCallInfos.set(callID, { ...info, traceId: newTraceId })
  }
  for (const [callID, span] of pendingSkillSpans) {
    if (span.traceId === oldTraceId) pendingSkillSpans.set(callID, { ...span, traceId: newTraceId })
  }
  if (currentTraceId === oldTraceId) currentTraceId = newTraceId
  uploadedTraceIds.delete(oldTraceId)
  generatedTraceIds.delete(oldTraceId)
}

function getTraceIdForSession(sessionId: string, preferredTraceId?: string): string {
  const existing = sessionToTrace.get(sessionId)
  if (existing) {
    if (
      preferredTraceId &&
      existing !== preferredTraceId &&
      generatedTraceIds.has(existing) &&
      !isSubagentSession(sessionId)
    ) {
      migrateTraceId(existing, preferredTraceId)
      return preferredTraceId
    }
    return existing
  }

  // A child session may be announced before the parent emits its first chat
  // event. Resolve through its parent instead of allocating a separate
  // fallback trace; this keeps event-order races from splitting one task.
  const parentSessionId = subagentParentBySession.get(sessionId)
  if (parentSessionId) {
    const parentTraceId = getTraceIdForSession(parentSessionId)
    sessionToTrace.set(sessionId, parentTraceId)
    return parentTraceId
  }

  if (!rootSessionId) {
    rootSessionId = sessionId
  }

  const traceId = preferredTraceId ?? generateUUID()
  if (!preferredTraceId) generatedTraceIds.add(traceId)

  sessionToTrace.set(sessionId, traceId)
  if (sessionId === rootSessionId || !currentTraceId) {
    currentTraceId = traceId
  }

  return traceId
}

/**
 * `session.created` is forwarded to plugins asynchronously. A child session can
 * otherwise reach chat.message before that event has associated it with its
 * parent trace, causing an irreversible trace-create ingestion event for the
 * child. Wait briefly for that specific event before allocating a trace so the
 * parent/child mapping wins over fallback trace allocation.
 */
async function getTraceIdAfterSessionCreated(sessionId: string, preferredTraceId?: string): Promise<string> {
  if (!createdSessionIds.has(sessionId)) {
    await new Promise<void>((resolve) => {
      const waiters = sessionCreatedWaiters.get(sessionId) ?? []
      let timeout: ReturnType<typeof setTimeout> | undefined
      const waiter = () => {
        if (timeout) clearTimeout(timeout)
        resolve()
      }
      timeout = setTimeout(() => {
        const remaining = (sessionCreatedWaiters.get(sessionId) ?? []).filter((entry) => entry !== waiter)
        if (remaining.length) sessionCreatedWaiters.set(sessionId, remaining)
        else sessionCreatedWaiters.delete(sessionId)
        resolve()
      }, SESSION_CREATED_WAIT_MS)
      waiters.push(waiter)
      sessionCreatedWaiters.set(sessionId, waiters)
    })
  }

  // A reused task session does not emit session.created again, and plugin event
  // delivery may lag behind the first child LLM event. Ask the session API for
  // its persisted parent before allocating a fallback trace. This only runs for
  // the one session still missing its creation event, so independent top-level
  // conversations retain their separate trace/session mapping.
  if (!createdSessionIds.has(sessionId) && !sessionToTrace.has(sessionId)) {
    const parentSessionId = await sessionParentResolver?.(sessionId)
    if (parentSessionId) await associateSubagentSession(sessionId, parentSessionId)

    // If OpenCode has not yet exposed parentID, but exactly one task call is
    // waiting for its child session, the child can be linked without creating
    // a fallback trace. Do not guess when more than one child is pending.
    if (!sessionToTrace.has(sessionId)) {
      const pendingParentSessionId = getUniquePendingSubagentParent()
      if (pendingParentSessionId) await associateSubagentSession(sessionId, pendingParentSessionId)
    }
  }
  return getTraceIdForSession(sessionId, preferredTraceId)
}

function markSessionCreated(sessionId: string) {
  createdSessionIds.add(sessionId)
  const waiters = sessionCreatedWaiters.get(sessionId)
  if (!waiters) return

  sessionCreatedWaiters.delete(sessionId)
  for (const resolve of waiters) resolve()
}

function migrateQueuedIngestionTraceId(oldTraceId: string, newTraceId: string) {
  const migrateEvent = (event: any) => {
    if (!event?.body || typeof event.body !== "object") return event

    const isTraceEvent = event.type === "trace-create" || event.type === "trace-update"
    const migrateTraceId = event.body.traceId === oldTraceId
    const migrateTraceEventId = isTraceEvent && event.body.id === oldTraceId
    if (!migrateTraceId && !migrateTraceEventId) return event

    const body = {
      ...event.body,
      ...(migrateTraceId ? { traceId: newTraceId } : {}),
      ...(migrateTraceEventId ? { id: newTraceId } : {}),
    }

    ingestionEventByteLengths.delete(event)
    return { ...event, body }
  }

  backgroundIngestionEvents = backgroundIngestionEvents.map((event, index) =>
    index < backgroundIngestionHead ? event : migrateEvent(event),
  )
  backgroundIngestionBytes = backgroundIngestionEvents
    .slice(backgroundIngestionHead)
    .reduce((total, event) => total + getBackgroundIngestionEventByteLength(event), 0)
  rebuildPendingBackgroundUpdateEvents()

  const migratedFailedEvents = failedIngestionEvents.map(migrateEvent)
  if (migratedFailedEvents.some((event, index) => event !== failedIngestionEvents[index])) {
    replaceFailedIngestionEvents(migratedFailedEvents)
  }
}

function getSessionObservationParent(
  sessionId: string,
  options?: { preferActiveGeneration?: boolean },
): string | undefined {
  if (options?.preferActiveGeneration) {
    const activeGeneration = getLatestActiveGeneration(sessionId)
    if (activeGeneration) return activeGeneration.genId
  }

  // Never borrow currentTraceId for an unassociated session. A concurrently
  // started top-level session must not inherit the previous session's active
  // skill parent before it receives its own trace mapping.
  const traceId = sessionToTrace.get(sessionId)
  const skillContext = getCurrentSkillContext(sessionId, traceId)
  if (skillContext) return skillContext.spanId

  // A few hook sequences are delivered before session.created has associated
  // the session. In that window use the trace-level skill parent, matching the
  // original skill-stack behaviour and keeping following LLM/tool nodes under
  // the skill that opened the group.
  if (traceId) {
    const activeSkillSpanId = activeSkillSpanByTrace.get(traceId)
    if (activeSkillSpanId) return activeSkillSpanId
  }

  // A skill running inside a subagent is more specific than the subagent
  // wrapper, so observations must nest under the skill first.
  const agentSpanId = sessionToAgentSpan.get(sessionId)
  if (agentSpanId) return agentSpanId
  return undefined
}

function getSessionSubagentType(sessionId: string, traceId = sessionToTrace.get(sessionId)): string | undefined {
  const agentSpanId = sessionToAgentSpan.get(sessionId)
  if (!traceId || !agentSpanId) return undefined
  return getObservationSubagentType(traceId, agentSpanId)
}

async function queuePendingSubagent(parentSessionId: string, entry: { traceId: string; agentSpanId: string }) {
  const waitingSessions = pendingSubagentSessions.get(parentSessionId)
  const waitingSessionId = waitingSessions?.shift()
  if (waitingSessions && waitingSessions.length === 0) pendingSubagentSessions.delete(parentSessionId)

  if (waitingSessionId) {
    await attachSubagentSession(waitingSessionId, entry.traceId, entry.agentSpanId)
    return
  }

  const queue = pendingSubagents.get(parentSessionId) ?? []
  queue.push(entry)
  pendingSubagents.set(parentSessionId, queue)
}

function getUniquePendingSubagentParent(): string | undefined {
  let parentSessionId: string | undefined
  let pendingCount = 0
  for (const [parentId, entries] of pendingSubagents) {
    pendingCount += entries.length
    if (entries.length) parentSessionId = parentId
    if (pendingCount > 1) return undefined
  }
  return pendingCount === 1 ? parentSessionId : undefined
}

async function associateSubagentSession(sessionId: string, parentSessionId: string) {
  // The API fallback can associate a child before its delayed session.created
  // event arrives. Do not consume the next pending task span a second time.
  if (subagentParentBySession.get(sessionId) === parentSessionId) return

  subagentParentBySession.set(sessionId, parentSessionId)
  const pending = consumePendingSubagent(parentSessionId)
  const inheritedTraceId = pending?.traceId || sessionToTrace.get(parentSessionId)
  if (inheritedTraceId) {
    sessionToTrace.set(sessionId, inheritedTraceId)
    currentTraceId = inheritedTraceId
  }
  if (pending?.agentSpanId) {
    await attachSubagentSession(sessionId, pending.traceId, pending.agentSpanId)
    return
  }
  rememberPendingSubagentSession(parentSessionId, sessionId)
}

function consumePendingSubagent(parentSessionId: string) {
  const queue = pendingSubagents.get(parentSessionId)
  if (!queue?.length) return

  const next = queue.shift()
  if (!queue.length) pendingSubagents.delete(parentSessionId)
  else pendingSubagents.set(parentSessionId, queue)
  return next
}

function rememberPendingSubagentSession(parentSessionId: string, sessionId: string) {
  const queue = pendingSubagentSessions.get(parentSessionId) ?? []
  if (!queue.includes(sessionId)) queue.push(sessionId)
  pendingSubagentSessions.set(parentSessionId, queue)
}

function isSubagentSession(sessionId: string): boolean {
  return sessionToAgentSpan.has(sessionId) || subagentParentBySession.has(sessionId)
}

async function attachSubagentSession(sessionId: string, traceId: string, agentSpanId: string) {
  const existingTraceId = sessionToTrace.get(sessionId)
  if (existingTraceId && existingTraceId !== traceId) {
    migrateTraceId(existingTraceId, traceId)
  }
  sessionToTrace.set(sessionId, traceId)
  sessionToAgentSpan.set(sessionId, agentSpanId)
  currentTraceId = traceId
  await reparentSessionObservations(sessionId, traceId, agentSpanId)
}

function recordSessionSpan(sessionId: string, spanId: string) {
  const spanIds = sessionSpanIds.get(sessionId) ?? new Set<string>()
  spanIds.add(spanId)
  sessionSpanIds.set(sessionId, spanIds)
}

async function reparentSessionObservations(sessionId: string, traceId: string, agentSpanId: string) {
  const subagentType = getObservationSubagentType(traceId, agentSpanId)
  for (const gen of allGenerations.filter((g) => g.sessionId === sessionId && g.traceId === traceId)) {
    const existingGeneration = traceBatches.get(traceId)?.generations.find((item) => item.id === gen.genId)
    const needsParentUpdate = gen.parentObservationId !== agentSpanId
    const needsSubagentTypeUpdate = !!subagentType && existingGeneration?.metadata?.subagent_type !== subagentType
    if (!needsParentUpdate && !needsSubagentTypeUpdate) continue

    if (needsParentUpdate) {
      gen.parentObservationId = agentSpanId
      gen.generationData.parentObservationId = agentSpanId
    }
    if (needsSubagentTypeUpdate) {
      gen.generationData.metadata = {
        ...(existingGeneration?.metadata ?? gen.generationData.metadata),
        subagent_type: subagentType,
      }
    }
    const generationUpdates: Partial<GenerationData> = {
      ...(needsParentUpdate ? { parentObservationId: agentSpanId } : {}),
      ...(needsSubagentTypeUpdate ? { metadata: gen.generationData.metadata } : {}),
    }
    updateGenerationInBatch(traceId, gen.genId, generationUpdates)
    updateGenerationImmediately(traceId, gen.genId, generationUpdates)
  }

  for (const spanId of sessionSpanIds.get(sessionId) ?? []) {
    const span = traceBatches.get(traceId)?.spans.find((s) => s.id === spanId)
    if (!span || span.id === agentSpanId) continue
    const needsParentUpdate = span.parentObservationId !== agentSpanId
    const needsSubagentTypeUpdate = !!subagentType && span.metadata?.subagent_type !== subagentType
    if (!needsParentUpdate && !needsSubagentTypeUpdate) continue

    const spanUpdates: Partial<SpanData> = {
      ...(needsParentUpdate ? { parentObservationId: agentSpanId } : {}),
      ...(needsSubagentTypeUpdate
        ? { metadata: { ...span.metadata, subagent_type: subagentType } }
        : {}),
    }
    updateSpanInBatch(traceId, spanId, spanUpdates)
    updateSpanImmediately(traceId, spanId, spanUpdates)
  }
}

function getSessionsForTrace(traceId: string): string[] {
  return [...sessionToTrace.entries()]
    .filter(([, mappedTraceId]) => mappedTraceId === traceId)
    .map(([sessionId]) => sessionId)
}

function hasActiveSessionsForTrace(traceId: string): boolean {
  return getSessionsForTrace(traceId).some((sessionId) => !idleSessionIds.has(sessionId))
}

function cleanupTraceState(traceId: string, sessionIds: string[]) {
  const sessionIdSet = new Set(sessionIds)
  const completedBatch = traceBatches.get(traceId)
  // Normal lifecycle cleanup is silent. The periodic gauges are sufficient;
  // one metric/log per trace would add noise unrelated to data delivery.
  clearCompletedObservationTrace(traceId)
  // Only LLM generations can own a completion timer. Tool/skill/subagent spans
  // complete synchronously and do not need a pointless timer-map lookup.
  for (const generation of completedBatch?.generations ?? []) {
    const timer = generationCompletionTimers.get(generation.id)
    if (timer) clearTimeout(timer)
    generationCompletionTimers.delete(generation.id)
  }

  traceBatches.delete(traceId)
  gens.delete(traceId)
  traceSkillInfos.delete(traceId)
  activeSkillSpanByTrace.delete(traceId)
  for (const key of [...observationSkillInfoCounts.keys()]) {
    if (key.startsWith(`${traceId}:`)) observationSkillInfoCounts.delete(key)
  }

  for (let i = allGenerations.length - 1; i >= 0; i--) {
    if (allGenerations[i]?.traceId === traceId) allGenerations.splice(i, 1)
  }

  for (const [sessionId, entry] of [...activeSkillContexts]) {
    if (entry.context.traceId === traceId) activeSkillContexts.delete(sessionId)
  }

  for (const [callID, info] of [...toolCallInfos]) {
    if (info.traceId === traceId) {
      toolCallInfos.delete(callID)
      toolSpanIds.delete(callID)
      toolResultSnapshots.delete(callID)
    }
  }
  for (const [callID, span] of [...pendingSkillSpans]) {
    if (span.traceId === traceId) pendingSkillSpans.delete(callID)
  }
  for (const [parentSessionId, pending] of [...pendingSubagents]) {
    const remaining = pending.filter((entry) => entry.traceId !== traceId)
    if (remaining.length) pendingSubagents.set(parentSessionId, remaining)
    else pendingSubagents.delete(parentSessionId)
  }

  for (const sessionId of sessionIdSet) {
    activeSkillContexts.delete(sessionId)
    sessionIdMap.delete(sessionId)
    activeGenerations.delete(sessionId)
    pendingGenerations.delete(sessionId)
    sessionSpanIds.delete(sessionId)
    messageCounter.delete(sessionId)
    userInputs.delete(sessionId)
    sessionAssistantOutputs.delete(sessionId)
    llmInputs.delete(sessionId)
    systemPrompts.delete(sessionId)
    selectedModelsBySession.delete(sessionId)
    sessionToAgentSpan.delete(sessionId)
    subagentParentBySession.delete(sessionId)
    idleSessionIds.delete(sessionId)
    createdSessionIds.delete(sessionId)
    sessionCreatedWaiters.delete(sessionId)
    trackedSessionIds.delete(sessionId)
    sessionToTrace.delete(sessionId)
    pendingSubagentSessions.delete(sessionId)
  }

  for (const [parentSessionId, waitingSessions] of [...pendingSubagentSessions]) {
    const remaining = waitingSessions.filter((sessionId) => !sessionIdSet.has(sessionId))
    if (remaining.length) pendingSubagentSessions.set(parentSessionId, remaining)
    else pendingSubagentSessions.delete(parentSessionId)
  }

  uploadedTraceIds.delete(traceId)
  lastEnqueuedTraceSnapshots.delete(traceId)
  generatedTraceIds.delete(traceId)
}

function refreshCurrentSessionPointers(endedTraceId: string, endedSessionIds: string[]) {
  const endedSessionIdSet = new Set(endedSessionIds)

  if (currentTraceId === endedTraceId) {
    currentTraceId =
      (currentSessionId && sessionToTrace.get(currentSessionId)) ||
      [...sessionToTrace.values()].find((traceId) => traceId !== endedTraceId) ||
      null
  }

  if (currentSessionId && endedSessionIdSet.has(currentSessionId)) {
    currentSessionId = [...trackedSessionIds].find((sessionId) => !endedSessionIdSet.has(sessionId)) || null
  }

  if (rootSessionId && endedSessionIdSet.has(rootSessionId)) {
    rootSessionId = [...sessionToTrace.keys()].find((sessionId) => !endedSessionIdSet.has(sessionId)) || null
  }
}

// 存储用户输入
const userInputs = new Map<string, string>()

// 存储每个 session 最后一条 assistant 输出，用于 trace 根节点 output 兜底
const sessionAssistantOutputs = new Map<string, string>()

// 存储 LLM 输入消息
const llmInputs = new Map<string, any[]>()

// 存储 system prompt
const systemPrompts = new Map<string, string[]>()

// 存储 command.execute.before 事件数据，用于关联到 LLM generation 元数据
const commandBeforeData = new Map<string, { name: string; source: string; id?: string; version?: string }>()

// 全局工具定义缓存
const allToolDefs = new Map<string, { id: string; description: string; parameters: any }>()

// 存储当前生成的索引
const currentGenIdx = new Map<string, number>()

// 跟踪的会话 ID 集合
const trackedSessionIds = new Set<string>()
const pendingSubagentSessions = new Map<string, string[]>()
const subagentParentBySession = new Map<string, string>()

// 消息计数器
const messageCounter = new Map<string, number>()

// Langfuse credentials (will be updated from project keys)
let publicKey: string
let secretKey: string
let userIdMetadata: string | null = null

// ==================== 常量 ====================

const OBSERVATION_TAGS = ["testagent"]

// ==================== write/edit/bash 内容转换 ====================

// write/edit: 匹配 filePath 参数，要求以支持的扩展名结尾
const BASE_FILE_RE = /测试案例[/\\].+\.(yaml|yml)$/

// bash: 匹配 command 字符串中被单引号或双引号包裹的路径片段
const BASH_FILE_RE = /测试案例[/\\].+\.(yaml|yml)['"]/

// 自动化测试目录下的 Python 文件
const AUTO_TEST_PY_FILE_RE = /自动化测试[/\\].+\.py$/

function isBaseFile(filePath: unknown): filePath is string {
  return typeof filePath === "string" && BASE_FILE_RE.test(filePath)
}

function isAutoTestPyFile(filePath: unknown): filePath is string {
  return typeof filePath === "string" && AUTO_TEST_PY_FILE_RE.test(filePath)
}

// 每个 TESTCASE_ID 替换为独立 TCuuid
function injectTestcaseIds(text: string): string {
  return text.replace(/TESTCASE_ID/g, () => {
    const uuid = generateUUID().replace(/-/g, "")
    const chars = uuid.split("")
    const word = "testagent"
    const indices = [2, 6, 9, 13, 16, 20, 23, 27, 30]
    
    indices.forEach((idx, i) => {
      if (idx < chars.length && i < word.length) {
        chars[idx] = word[i]
      }
    })
    
    return `TC${chars.join("")}`
  })
}

// 检查 testcase_id 是否在指定位置包含 "testagent"
// 调用方已通过正则保证格式: TC[a-z0-9]{32}
function hasTestagentPattern(testcaseId: string): boolean {
  const chars = testcaseId.slice(2) // 去掉 "TC" 前缀
  const word = "testagent"
  const indices = [2, 6, 9, 13, 16, 20, 23, 27, 30]
  
  // 检查特定位置是否包含 testagent 字符
  return indices.every((idx, i) => chars[idx] === word[i])
}

// 生成符合 testagent 模式的新 testcase_id
function generateTestagentTestcaseId(): string {
  const uuid = generateUUID().replace(/-/g, "")
  const chars = uuid.split("")
  const word = "testagent"
  const indices = [2, 6, 9, 13, 16, 20, 23, 27, 30]
  
  indices.forEach((idx, i) => {
    if (idx < chars.length && i < word.length) {
      chars[idx] = word[i]
    }
  })
  
  return `TC${chars.join("")}`
}

// 替换 YAML 中不符合 testagent 模式的 testcase_id
function replaceNonTestagentTestcaseIds(text: string): string {
  // 匹配 testcase_id: TC... 格式
  return text.replace(/testcase_id:\s*(TC[a-z0-9]{32})/g, (match, testcaseId) => {
    if (hasTestagentPattern(testcaseId)) {
      return match // 保留符合模式的 testcase_id
    }
    return match.replace(testcaseId, generateTestagentTestcaseId())
  })
}

function transformWriteArgs(tool: string, args: any) {
  if (
    tool === "write" &&
    isBaseFile(args?.filePath) &&
    typeof args.content === "string" &&
    args.content.includes("TESTCASE_ID")
  ) {
    args.content = injectTestcaseIds(args.content)
  }
  if (
    tool === "edit" &&
    isBaseFile(args?.filePath) &&
    typeof args.newString === "string" &&
    args.newString.includes("TESTCASE_ID")
  ) {
    args.newString = injectTestcaseIds(args.newString)
  }
  if (
    tool === "bash" &&
    typeof args?.command === "string" &&
    args.command.includes("TESTCASE_ID") &&
    BASH_FILE_RE.test(args.command)
  ) {
    args.command = injectTestcaseIds(args.command)
  }
}

// ==================== 工具函数 ====================

function sanitize(input: any): any {
  if (typeof input !== "object" || !input) return input
  const out: any = {}
  for (const [k, v] of Object.entries(input)) {
    out[k] = /^(key|secret|password|token)$/i.test(k) ? "[REDACTED]" : sanitize(v)
  }
  return out
}

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * 创建新的 Trace 批次数据
 */
function createTraceBatch(sessionId: string, input: string, ctx: any, traceId: string): TraceBatch {
  const existing = traceBatches.get(traceId)
  if (existing) {
    if (!existing.input && input) existing.input = input
    if (!existing.name && input) existing.name = input.length > 100 ? input.slice(0, 100) + "..." : input
    if (!existing.sessionId) existing.sessionId = sessionId
    return existing
  }

  const traceName = input.length > 100 ? input.slice(0, 100) + "..." : input

  const batch: TraceBatch = {
    id: traceId,
    name: traceName,
    sessionId,
    input,
    tags: OBSERVATION_TAGS,
    metadata: {
      tags: OBSERVATION_TAGS,
      project: ctx.project?.name,
      directory: ctx.directory,
      ...baseMetadata(),
    },
    generations: [],
    spans: [],
  }

  traceBatches.set(traceId, batch)
  gens.set(traceId, [])
  currentGenIdx.set(traceId, -1)

  return batch
}

/**
 * 上传事件批次到 Langfuse  ingestion API
 */
async function readResponseTextSafe(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch (e) {
    return `[failed to read response body: ${String(e)}]`
  }
}

function truncateErrorDetail(value: unknown, maxLength = MAX_ERROR_DETAIL_LENGTH): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`
}

function summarizeResponseBody(text: string): string {
  if (!text) return ""

  try {
    const parsed = JSON.parse(text)
    return truncateErrorDetail(parsed)
  } catch {
    return truncateErrorDetail(text)
  }
}

function normalizeErrorDetail(error: unknown) {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ? truncateErrorDetail(error.stack) : undefined,
      cause: cause === undefined ? undefined : truncateErrorDetail(cause),
    }
  }

  return {
    name: typeof error,
    message: truncateErrorDetail(error),
  }
}

function shouldLogIngestionFailure() {
  const now = Date.now()
  if (now - lastIngestionFailureLogAt < INGESTION_FAILURE_LOG_INTERVAL_MS) return false
  lastIngestionFailureLogAt = now
  return true
}

async function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  timeoutMs = LANGFUSE_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

function hasObservationTags(tags: unknown) {
  return (
    Array.isArray(tags) &&
    tags.length === OBSERVATION_TAGS.length &&
    OBSERVATION_TAGS.every((tag) => tags.includes(tag))
  )
}

function withEventBodyTags(event: any) {
  if (!event || typeof event !== "object" || !event.body) return event
  if (hasObservationTags(event.body.tags) && hasObservationTags(event.body.metadata?.tags)) return event

  return {
    ...event,
    body: withEventMetadataTags(event.body, event.body?.metadata?.hookReceivedAt),
  }
}

function toUploadIngestionEvent(event: any) {
  if (!event || typeof event !== "object" || event.__langfuseRetryCount === undefined) return event
  const { __langfuseRetryCount: _retryCount, ...ingestionEvent } = event
  return ingestionEvent
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf-8")
}

async function uploadToIngestion(events: any[], source: "background" | "retry") {
  if (events.length === 0) return { successes: [], errors: [] }

  const successes: any[] = []
  const errors: any[] = []
  const emptyBatchBytes = Buffer.byteLength('{"batch":[]}', "utf-8")
  let batchEvents: any[] = []
  let serializedEvents: string[] = []
  let batchBytes = emptyBatchBytes

  const uploadCurrentBatch = async () => {
    if (batchEvents.length === 0) return
    const body = `{"batch":[${serializedEvents.join(",")}]}`
    const result = await uploadToIngestionChunk(batchEvents, body, source)
    successes.push(...(Array.isArray(result.successes) ? result.successes : []))
    errors.push(...(Array.isArray(result.errors) ? result.errors : []))
    batchEvents = []
    serializedEvents = []
    batchBytes = emptyBatchBytes
  }

  for (const event of events) {
    const taggedEvent = toUploadIngestionEvent(event)
    let serializedEvent: string
    try {
      serializedEvent = JSON.stringify(taggedEvent)
      if (typeof serializedEvent !== "string") throw new TypeError("Ingestion event is not serializable")
    } catch (e) {
      const errorDetail = normalizeErrorDetail(e)
      if (shouldLogIngestionFailure()) {
        trackEvent("both", {
          level: "error",
          message: `数据上报序列化失败: ${errorDetail.name}${errorDetail.message ? ` - ${errorDetail.message}` : ""}`,
          data: { error: errorDetail, eventId: event?.id },
          metricName: "plugin.langfuse.ingestion.error",
          metricValue: 1,
          tags: { error: "serialization" },
        })
      }
      errors.push({ id: event?.id, status: 500, error: String(e) })
      continue
    }

    const serializedEventBytes = Buffer.byteLength(serializedEvent, "utf-8")
    const separatorBytes = batchEvents.length > 0 ? 1 : 0
    if (batchEvents.length > 0 && batchBytes + separatorBytes + serializedEventBytes > MAX_INGESTION_BATCH_BYTES) {
      await uploadCurrentBatch()
    }

    batchEvents.push(taggedEvent)
    serializedEvents.push(serializedEvent)
    batchBytes += (batchEvents.length > 1 ? 1 : 0) + serializedEventBytes
    if (batchBytes >= MAX_INGESTION_BATCH_BYTES) await uploadCurrentBatch()
  }

  await uploadCurrentBatch()
  return { successes, errors }
}

async function uploadToIngestionChunk(taggedEvents: any[], body: string, source: "background" | "retry") {
  if (taggedEvents.length === 0) return { successes: [], errors: [] }

  const credentials = btoa(`${publicKey}:${secretKey}`)
  const traceId = taggedEvents?.[0]?.body?.traceId || taggedEvents?.[0]?.body?.id
  const projectId = taggedEvents?.[0]?.body?.metadata?.projectId
  trackEvent("metric", {
    metricName: "plugin.langfuse.ingestion.attempt",
    metricValue: 1,
    tags: ingestionDiagnosticTags(taggedEvents, {
      node: "ingestion",
      action: "upload_batch",
      status: "started",
      source,
    }),
  })
  try {
    const res = await fetchWithTimeout(`${LANGFUSE_BASE_URL}/api/public/ingestion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
        Authorization: `Basic ${credentials}`,
      },
      body,
    })

    if (res.ok) {
      trackEvent("metric", {
        metricName: "plugin.langfuse.ingestion.success",
        metricValue: 1,
        tags: ingestionDiagnosticTags(taggedEvents, {
          node: "ingestion",
          action: "upload_batch",
          status: "success",
          source,
          ...(traceId ? { firstTraceId: traceId } : {}),
          ...(projectId ? { projectId } : {}),
        }),
      })
      return { successes: taggedEvents.map((event) => ({ id: event.id })), errors: [] }
    }

    const text = await readResponseTextSafe(res)
    const responseBody = summarizeResponseBody(text)
    const reason = res.status === 413 ? "payload_too_large" : "request_failed"
    const statusText = res.statusText || ""
    if (shouldLogIngestionFailure()) {
      trackEvent("both", {
        level: "error",
        message: `数据上报失败: HTTP ${res.status}${statusText ? ` ${statusText}` : ""}${responseBody ? ` - ${responseBody.slice(0, 300)}` : ""}`,
        data: {
          status: res.status,
          statusText,
          reason,
          responseBody,
          traceId,
          projectId,
        },
        metricName: "plugin.langfuse.ingestion.error",
        metricValue: 1,
        tags: ingestionDiagnosticTags(taggedEvents, {
          node: "ingestion",
          action: "upload_batch",
          status: "failed",
          source,
          httpStatus: String(res.status),
          reason,
        }),
      })
    }
    return { successes: [], errors: taggedEvents.map((event) => ({ id: event.id, status: res.status, error: text })) }
  } catch (e) {
    const errorDetail = normalizeErrorDetail(e)
    const isTimeout = errorDetail.name === "AbortError"
    if (shouldLogIngestionFailure()) {
      trackEvent("both", {
        level: "error",
        message: `数据上报异常: ${errorDetail.name}${errorDetail.message ? ` - ${errorDetail.message}` : ""}`,
        data: {
          error: errorDetail,
          reason: isTimeout ? "timeout" : "exception",
          traceId,
          projectId,
        },
        metricName: "plugin.langfuse.ingestion.error",
        metricValue: 1,
        tags: ingestionDiagnosticTags(taggedEvents, {
          node: "ingestion",
          action: "upload_batch",
          status: "exception",
          source,
          error: isTimeout ? "timeout" : "exception",
        }),
      })
    }
    return { successes: [], errors: taggedEvents.map((event) => ({ id: event.id, status: 500, error: String(e) })) }
  }
}

function withEventMetadataTags(body: any, hookReceivedAt?: string) {
  if (!body || typeof body !== "object") return body

  return {
    ...body,
    tags: OBSERVATION_TAGS,
    metadata: {
      ...(body.metadata ?? {}),
      ...(hookReceivedAt ? { hookReceivedAt } : {}),
      tags: OBSERVATION_TAGS,
    },
  }
}

function buildIngestionEvent(type: string, body: any, timestamp = new Date().toISOString(), hookReceivedAt = new Date().toISOString()) {
  return {
    id: generateUUID(),
    timestamp,
    type,
    body: {
      ...withEventMetadataTags(body, hookReceivedAt),
      release: TESTAGENT_VERSION,
    },
  }
}

function getFailedEvents(events: any[], result: any): any[] {
  const errors = Array.isArray(result?.errors) ? result.errors : []
  if (errors.length === 0) return []

  const successes = Array.isArray(result?.successes) ? result.successes : []
  const successIds = new Set(successes.map((s: any) => s?.id).filter(Boolean))
  const errorIds = new Set(errors.map((e: any) => e?.id).filter((id: string) => id && id !== "batch"))

  // Langfuse may return a batch-level error when the whole request failed.
  if (errors.some((e: any) => e?.id === "batch") || (successIds.size === 0 && errorIds.size === 0)) {
    return events
  }

  if (successIds.size > 0) {
    return events.filter((event) => !successIds.has(event.id))
  }

  return events.filter((event) => errorIds.has(event.id))
}

function getOversizedIngestionEvents(events: any[], result: any): any[] {
  const errors = Array.isArray(result?.errors) ? result.errors : []
  if (errors.length === 0) return []

  const successIds = new Set((Array.isArray(result?.successes) ? result.successes : []).map((s: any) => s?.id).filter(Boolean))
  const batchOversized = errors.some((e: any) => e?.id === "batch" && Number(e?.status) === 413)
  const oversizedIds = new Set(
    errors
      .map((e: any) => (Number(e?.status) === 413 ? e?.id : undefined))
      .filter((id: string) => id && id !== "batch"),
  )

  if (batchOversized) return events.filter((event) => !successIds.has(event.id))
  return events.filter((event) => oversizedIds.has(event.id))
}

function getIngestionObservationKey(event: any): string {
  const type = typeof event?.type === "string" ? event.type : "unknown"
  const observationType = type.split("-")[0] || "unknown"
  const body = event?.body ?? {}
  const observationId = body.id || body.traceId || event?.id
  const traceId = body.traceId || (observationType === "trace" ? observationId : "unknown-trace")
  return `${observationType}:${traceId}:${observationId}`
}

function isValidIngestionEvent(event: any) {
  return (
    !!event &&
    typeof event === "object" &&
    typeof event.id === "string" &&
    typeof event.type === "string" &&
    !!event.body
  )
}

function getIngestionUpdateKey(event: any): string | undefined {
  if (!event?.type?.endsWith("-update") || !event?.body?.id) return
  return `${event.type}:${event.body.id}`
}

function isObservationCompletionEvent(event: any) {
  return event?.body?.metadata?.observationCompleted === true
}

function preservePendingObservationCompletion(existingEvent: any, nextEvent: any) {
  if (!isObservationCompletionEvent(existingEvent) || isObservationCompletionEvent(nextEvent)) return nextEvent
  return {
    ...nextEvent,
    // Keep one stable event ID so transport retries remain idempotent.
    id: existingEvent.id,
    body: {
      ...existingEvent.body,
      ...nextEvent.body,
      metadata: {
        ...(existingEvent.body?.metadata ?? {}),
        ...(nextEvent.body?.metadata ?? {}),
      },
    },
  }
}

function getBackgroundIngestionQueueSize() {
  return backgroundIngestionEvents.length - backgroundIngestionHead
}

function rebuildPendingBackgroundUpdateEvents() {
  pendingBackgroundUpdateEvents.clear()
  for (let index = backgroundIngestionHead; index < backgroundIngestionEvents.length; index += 1) {
    const updateKey = getIngestionUpdateKey(backgroundIngestionEvents[index])
    if (updateKey) pendingBackgroundUpdateEvents.set(updateKey, index)
  }
}

function compactBackgroundIngestionQueue() {
  if (backgroundIngestionHead === 0) return
  if (backgroundIngestionHead === backgroundIngestionEvents.length) {
    backgroundIngestionEvents = []
    backgroundIngestionHead = 0
    pendingBackgroundUpdateEvents.clear()
    return
  }
  if (backgroundIngestionHead < 1024 && backgroundIngestionHead * 2 < backgroundIngestionEvents.length) return

  backgroundIngestionEvents = backgroundIngestionEvents.slice(backgroundIngestionHead)
  backgroundIngestionHead = 0
  rebuildPendingBackgroundUpdateEvents()
}

function removePendingBackgroundUpdateIndexes(start: number, end: number) {
  for (let index = start; index < end; index += 1) {
    const updateKey = getIngestionUpdateKey(backgroundIngestionEvents[index])
    if (updateKey && pendingBackgroundUpdateEvents.get(updateKey) === index) {
      pendingBackgroundUpdateEvents.delete(updateKey)
    }
  }
}

function rebuildFailedIngestionUpdateEventIds() {
  failedIngestionUpdateEventIds.clear()
  for (const event of failedIngestionEvents) {
    const updateKey = getIngestionUpdateKey(event)
    if (!updateKey) continue
    const eventIds = failedIngestionUpdateEventIds.get(updateKey) ?? new Set<string>()
    eventIds.add(event.id)
    failedIngestionUpdateEventIds.set(updateKey, eventIds)
  }
}

function removeSupersededFailedIngestionUpdates(events: any[], retainedEventIds = new Set<string>()) {
  const replacementByUpdateKey = new Map<string, any>()
  for (const event of events) {
    const updateKey = getIngestionUpdateKey(event)
    if (updateKey) replacementByUpdateKey.set(updateKey, event)
  }
  const updateKeys = new Set(replacementByUpdateKey.keys())
  if (updateKeys.size === 0 || failedIngestionEvents.length === 0) return

  const effectiveRetainedEventIds = new Set(retainedEventIds)
  let mergedCompletionUpdate = false
  // A completion update is the only event allowed to carry the terminal
  // marker. If it is waiting for retry, a newer ordinary update must enrich
  // that event instead of superseding it and silently losing completion.
  for (let index = 0; index < failedIngestionEvents.length; index += 1) {
    const failedEvent = failedIngestionEvents[index]
    const updateKey = getIngestionUpdateKey(failedEvent)
    const replacement = updateKey ? replacementByUpdateKey.get(updateKey) : undefined
    if (!replacement || !isObservationCompletionEvent(failedEvent) || isObservationCompletionEvent(replacement)) {
      continue
    }

    const merged = preservePendingObservationCompletion(failedEvent, replacement)
    if (failedEvent.__langfuseRetryCount !== undefined) {
      merged.__langfuseRetryCount = failedEvent.__langfuseRetryCount
    }
    failedIngestionEvents[index] = merged
    mergedCompletionUpdate = true
    effectiveRetainedEventIds.add(failedEvent.id)
    // When the replacement was also queued as failed, its data is now already
    // carried by the stable completion event and the duplicate can be removed.
    effectiveRetainedEventIds.delete(replacement.id)
  }

  const supersededEventIds = new Set<string>()
  for (const updateKey of updateKeys) {
    for (const eventId of failedIngestionUpdateEventIds.get(updateKey) ?? []) {
      if (!effectiveRetainedEventIds.has(eventId)) supersededEventIds.add(eventId)
    }
  }
  if (supersededEventIds.size === 0) {
    if (mergedCompletionUpdate) replaceFailedIngestionEvents([...failedIngestionEvents])
    return
  }

  const remainingEvents = failedIngestionEvents.filter((event) => !supersededEventIds.has(event.id))
  replaceFailedIngestionEvents(remainingEvents)
  if (remainingEvents.length === 0) {
    failedIngestionRetryAttempt = 0
    failedIngestionNextRetryAt = 0
    backgroundBatchesSinceFailedRetry = 0
  }
}

function resetFailedIngestionQueue() {
  failedIngestionEvents.splice(0)
  failedIngestionQueueBytes = 0
  failedIngestionRetryAttempt = 0
  failedIngestionNextRetryAt = 0
  backgroundBatchesSinceFailedRetry = 0
  pendingBackgroundUpdateEvents.clear()
  failedIngestionUpdateEventIds.clear()
  // oversizedIngestionObservationKeys.clear()
}

async function deletePersistedFailedIngestionQueues() {
  try {
    const entries = await readdir(TESTAGENT_DATA_DIR, { withFileTypes: true })
    const queueFiles = entries.filter(
      (entry) => entry.isFile() && /^langfuse-ingestion-queue(?:-.*)?\.json$/.test(entry.name),
    )

    const deletionResults = await Promise.allSettled(
      queueFiles.map((entry) => unlink(join(TESTAGENT_DATA_DIR, entry.name))),
    )
    const failedFiles = queueFiles
      .filter((_, index) => deletionResults[index]?.status === "rejected")
      .map((entry) => entry.name)

    if (failedFiles.length > 0) {
      trackEvent("both", {
        level: "warn",
        message: "删除历史数据上报重试队列失败",
        data: { failedFiles },
        metricName: "plugin.langfuse.queue.cleanup.error",
        metricValue: failedFiles.length,
        tags: { type: "ingestionRetryQueue", action: "delete", reason: "exception" },
      })
    }
  } catch (e: any) {
    if (e?.code === "ENOENT") return
    trackEvent("both", {
      level: "warn",
      message: "扫描历史数据上报重试队列失败",
      data: { error: String(e), directory: TESTAGENT_DATA_DIR },
      metricName: "plugin.langfuse.queue.cleanup.error",
      metricValue: 1,
      tags: { type: "ingestionRetryQueue", action: "scan", reason: "exception" },
    })
  }
}

function getIngestionEventByteLength(event: any): number | undefined {
  try {
    if (event && typeof event === "object") {
      const cached = ingestionEventByteLengths.get(event)
      if (cached !== undefined) return cached
      const byteLength = jsonByteLength(event)
      ingestionEventByteLengths.set(event, byteLength)
      return byteLength
    }
    return jsonByteLength(event)
  } catch {
    return undefined
  }
}

function getBackgroundIngestionEventByteLength(event: any) {
  return getIngestionEventByteLength(event) ?? 0
}

function removeBackgroundIngestionEvents(end: number) {
  const start = backgroundIngestionHead
  const events = backgroundIngestionEvents.slice(start, end)
  for (const event of events) {
    backgroundIngestionBytes = Math.max(0, backgroundIngestionBytes - getBackgroundIngestionEventByteLength(event))
  }
  removePendingBackgroundUpdateIndexes(start, end)
  backgroundIngestionHead = end
  compactBackgroundIngestionQueue()
  return events
}

function enqueueFailedIngestionEvents(events: any[]) {
  if (events.length === 0) return []

  const existingIds = new Set(failedIngestionEvents.map((event) => event.id))
  const acceptedEvents: any[] = []
  let droppedCount = 0
  for (const event of events) {
    if (!isValidIngestionEvent(event) || existingIds.has(event.id)) continue
    const taggedEvent = withEventBodyTags(event)
    const eventBytes = getIngestionEventByteLength(taggedEvent)
    if (
      eventBytes === undefined ||
      failedIngestionEvents.length >= MAX_FAILED_INGESTION_EVENTS ||
      failedIngestionQueueBytes + eventBytes > MAX_FAILED_INGESTION_QUEUE_BYTES
    ) {
      droppedCount += 1
      continue
    }

    failedIngestionEvents.push(taggedEvent)
    acceptedEvents.push(taggedEvent)
    failedIngestionQueueBytes += eventBytes
    existingIds.add(event.id)
    const updateKey = getIngestionUpdateKey(taggedEvent)
    if (updateKey) {
      const eventIds = failedIngestionUpdateEventIds.get(updateKey) ?? new Set<string>()
      eventIds.add(taggedEvent.id)
      failedIngestionUpdateEventIds.set(updateKey, eventIds)
    }
  }

  if (droppedCount > 0 && Date.now() - lastFailedIngestionQueueDropLogAt >= INGESTION_FAILURE_LOG_INTERVAL_MS) {
    lastFailedIngestionQueueDropLogAt = Date.now()
    trackEvent("both", {
      level: "warn",
      message: "数据上报重试队列已达上限，丢弃新增事件",
      data: {
        droppedCount,
        queueSize: failedIngestionEvents.length,
        queueBytes: failedIngestionQueueBytes,
        maxQueueSize: MAX_FAILED_INGESTION_EVENTS,
        maxQueueBytes: MAX_FAILED_INGESTION_QUEUE_BYTES,
      },
      metricName: "plugin.langfuse.queue.drop",
      metricValue: droppedCount,
      tags: { type: "ingestionRetryQueue", reason: "queue_limit" },
    })
  }

  // Keep an older failed update until its replacement is safely in the in-memory retry queue.
  if (acceptedEvents.length > 0) {
    removeSupersededFailedIngestionUpdates(acceptedEvents, new Set(acceptedEvents.map((event) => event.id)))
  }
  return acceptedEvents
}

function replaceFailedIngestionEvents(events: any[]) {
  failedIngestionEvents.splice(0, failedIngestionEvents.length, ...events)
  failedIngestionQueueBytes = events.reduce((total, event) => total + (getIngestionEventByteLength(event) ?? 0), 0)
  rebuildFailedIngestionUpdateEventIds()
}

function markIngestionEventsAttempted(events: any[], failedEvents: any[]) {
  const attemptedIds = new Set(events.map((event) => event.id))
  const failedIds = new Set(failedEvents.map((event) => event.id))
  const remainingEvents = failedIngestionEvents.filter(
    (event) => !attemptedIds.has(event.id) || failedIds.has(event.id),
  )
  replaceFailedIngestionEvents(remainingEvents)
}

function getRetryableFailedIngestionEvents(events: any[], result: any): any[] {
  const failedEvents = getFailedEvents(events, result)
  const oversizedEvents = getOversizedIngestionEvents(events, result)
  const oversizedIds = new Set(oversizedEvents.map((event) => event.id))
  if (oversizedEvents.length > 0) {
    trackEvent("both", {
      level: "warn",
      message: "数据上报内容过大，已丢弃且不会重试",
      data: { droppedCount: oversizedEvents.length },
      metricName: "plugin.langfuse.queue.drop",
      metricValue: oversizedEvents.length,
      tags: { type: "ingestionRetryQueue", reason: "payload_too_large" },
    })
  }
  return failedEvents.filter((event) => !oversizedIds.has(event.id))
}

function applyFailedIngestionRetryLimit(events: any[], options?: { countRetryAttempt?: boolean }): any[] {
  const retryableEvents: any[] = []
  let droppedCount = 0
  const countRetryAttempt = options?.countRetryAttempt !== false

  for (const event of events) {
    const retryCount = Number(event.__langfuseRetryCount ?? 0) + (countRetryAttempt ? 1 : 0)
    if (retryCount >= MAX_FAILED_INGESTION_RETRY_ATTEMPTS && countRetryAttempt) {
      droppedCount += 1
      continue
    }
    if (countRetryAttempt) {
      event.__langfuseRetryCount = retryCount
      ingestionEventByteLengths.delete(event)
    }
    retryableEvents.push(event)
  }

  if (droppedCount > 0) {
    trackEvent("both", {
      level: "warn",
      message: "数据上报重试次数已达上限，丢弃事件",
      data: { droppedCount, maxRetryAttempts: MAX_FAILED_INGESTION_RETRY_ATTEMPTS },
      metricName: "plugin.langfuse.queue.drop",
      metricValue: droppedCount,
      tags: { type: "ingestionRetryQueue", reason: "retry_attempts_exhausted" },
    })
  }

  return retryableEvents
}

function recordIngestionAttemptOutcome(retryableFailureCount: number) {
  if (retryableFailureCount === 0) {
    failedIngestionRetryAttempt = 0
    failedIngestionNextRetryAt = 0
    return
  }

  failedIngestionRetryAttempt += 1
  failedIngestionNextRetryAt = Date.now() + getFailedIngestionRetryDelayMs()
}

function getFailedIngestionRetryDelayMs() {
  if (failedIngestionRetryAttempt === 0) return 0

  const exponentialDelay = Math.min(
    FAILED_INGESTION_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, failedIngestionRetryAttempt - 1),
    FAILED_INGESTION_RETRY_MAX_DELAY_MS,
  )
  return exponentialDelay + Math.round(exponentialDelay * Math.random() * 0.25)
}

function scheduleInitialFailedIngestionRetry() {
  if (failedIngestionNextRetryAt > 0) return
  failedIngestionRetryAttempt = Math.max(1, failedIngestionRetryAttempt)
  failedIngestionNextRetryAt = Date.now() + getFailedIngestionRetryDelayMs()
}

function isFailedIngestionRetryDue() {
  return failedIngestionNextRetryAt === 0 || Date.now() >= failedIngestionNextRetryAt
}

function getFailedIngestionRetryWaitMs() {
  return Math.max(0, failedIngestionNextRetryAt - Date.now())
}

async function retryFailedIngestionEvents() {
  if (retryingFailedIngestionEvents || failedIngestionEvents.length === 0 || !isFailedIngestionRetryDue()) return

  retryingFailedIngestionEvents = true
  const events = failedIngestionEvents.slice(0, FAILED_INGESTION_RETRY_BATCH_SIZE)
  trackEvent("metric", {
    metricName: "plugin.langfuse.queue.retry.attempt",
    metricValue: 1,
    tags: ingestionDiagnosticTags(events, {
      node: "ingestionRetryQueue",
      action: "retry_upload",
      status: "started",
      queueSizeBefore: String(failedIngestionEvents.length),
    }),
  })
  try {
    const result = await uploadToIngestion(events, "retry")
    const retryableFailedEvents = getRetryableFailedIngestionEvents(events, result)
    const retainedFailedEvents = applyFailedIngestionRetryLimit(retryableFailedEvents)
    markIngestionEventsAttempted(events, retainedFailedEvents)
    trackEvent("metric", {
      metricName: "plugin.langfuse.queue.retry.result",
      metricValue: 1,
      tags: ingestionDiagnosticTags(events, {
        node: "ingestionRetryQueue",
        action: "retry_upload",
        status: retainedFailedEvents.length === 0 ? "all_removed" : "partially_retained",
        attemptedCount: String(events.length),
        retainedCount: String(retainedFailedEvents.length),
        queueSizeAfter: String(failedIngestionEvents.length),
      }),
    })
    recordIngestionAttemptOutcome(retainedFailedEvents.length)
    backgroundBatchesSinceFailedRetry = 0
  } finally {
    retryingFailedIngestionEvents = false
  }
}

async function ingestEvents(events: any[], options?: { queueOnFailure?: boolean }) {
  if (events.length === 0) return { successes: [], errors: [] }

  const shouldQueueForRetry = options?.queueOnFailure !== false
  const result = await uploadToIngestion(events, "background")
  const succeededIds = new Set((Array.isArray(result.successes) ? result.successes : []).map((event: any) => event?.id))
  const succeededUpdateEvents = events.filter((event) => succeededIds.has(event.id) && getIngestionUpdateKey(event))
  if (succeededUpdateEvents.length > 0) {
    removeSupersededFailedIngestionUpdates(succeededUpdateEvents)
  }
  const retryableFailedEvents = getRetryableFailedIngestionEvents(events, result)
  const retainedFailedEvents = applyFailedIngestionRetryLimit(retryableFailedEvents, { countRetryAttempt: false })

  if (shouldQueueForRetry && retainedFailedEvents.length > 0) {
    enqueueFailedIngestionEvents(retainedFailedEvents)
  }

  return { ...result, retryableFailureCount: retainedFailedEvents.length }
}

function scheduleBackgroundIngestion(events: any[]) {
  if (events.length === 0) return

  for (const event of events) {
    const updateKey = getIngestionUpdateKey(event)
    const existingIndex = updateKey ? pendingBackgroundUpdateEvents.get(updateKey) : undefined
    if (existingIndex !== undefined) {
      if (existingIndex >= backgroundIngestionHead) {
        backgroundIngestionBytes = Math.max(
          0,
          backgroundIngestionBytes - getBackgroundIngestionEventByteLength(backgroundIngestionEvents[existingIndex]),
        )
        const coalescedEvent = preservePendingObservationCompletion(
          backgroundIngestionEvents[existingIndex],
          event,
        )
        backgroundIngestionEvents[existingIndex] = coalescedEvent
        backgroundIngestionBytes += getBackgroundIngestionEventByteLength(coalescedEvent)
        pendingBackgroundUpdateEvents.set(updateKey!, existingIndex)
        continue
      }
      pendingBackgroundUpdateEvents.delete(updateKey!)
    }

    backgroundIngestionEvents.push(event)
    backgroundIngestionBytes += getBackgroundIngestionEventByteLength(event)
    if (updateKey) pendingBackgroundUpdateEvents.set(updateKey, backgroundIngestionEvents.length - 1)
  }

  if (
    getBackgroundIngestionQueueSize() > MAX_BACKGROUND_INGESTION_EVENTS ||
    backgroundIngestionBytes > MAX_BACKGROUND_INGESTION_BYTES
  ) {
    let remainingCount = getBackgroundIngestionQueueSize()
    let remainingBytes = backgroundIngestionBytes
    let overflowEnd = backgroundIngestionHead
    while (
      overflowEnd < backgroundIngestionEvents.length &&
      (remainingCount > MAX_BACKGROUND_INGESTION_EVENTS || remainingBytes > MAX_BACKGROUND_INGESTION_BYTES)
    ) {
      remainingCount -= 1
      remainingBytes = Math.max(0, remainingBytes - getBackgroundIngestionEventByteLength(backgroundIngestionEvents[overflowEnd]))
      overflowEnd += 1
    }
    removeBackgroundIngestionEvents(overflowEnd)
    // 排查期间丢弃后台队列溢出的 event，不转入失败重试队列。
  }

  trackEvent("metric", {
    metricName: "plugin.langfuse.ingestion.queue.enqueued",
    metricValue: events.length,
    tags: ingestionDiagnosticTags(events, {
      node: "backgroundIngestionQueue",
      action: "enqueue",
      status: "scheduled",
      queueSize: String(getBackgroundIngestionQueueSize()),
      queueBytes: String(backgroundIngestionBytes),
    }),
  })
  scheduleBackgroundIngestionDrain()
}

function scheduleBackgroundIngestionDrain(delayMs = 0) {
  if (backgroundIngestionDrainPromise) return

  const scheduledAt = Date.now() + delayMs
  if (backgroundIngestionDrainScheduled && backgroundIngestionDrainScheduledAt <= scheduledAt) return
  if (backgroundIngestionDrainTimer) clearTimeout(backgroundIngestionDrainTimer)

  backgroundIngestionDrainScheduled = true
  backgroundIngestionDrainScheduledAt = scheduledAt

  backgroundIngestionDrainTimer = setTimeout(() => {
    backgroundIngestionDrainTimer = null
    backgroundIngestionDrainScheduled = false
    backgroundIngestionDrainScheduledAt = 0
    void drainBackgroundIngestion()
  }, Math.max(0, delayMs))
  if (delayMs > 0) backgroundIngestionDrainTimer.unref?.()
}

async function drainBackgroundIngestion(options?: { retryFailed?: boolean }) {
  if (backgroundIngestionDrainPromise) return backgroundIngestionDrainPromise

  backgroundIngestionDrainPromise = (async () => {
    // Ensure the promise is assigned before an empty queue can reach finally.
    await Promise.resolve()
    const allowFailedRetry = FAILED_INGESTION_RETRY_ENABLED && options?.retryFailed !== false
    try {
      while (getBackgroundIngestionQueueSize() > 0) {
        if (
          allowFailedRetry &&
          failedIngestionEvents.length > 0 &&
          backgroundBatchesSinceFailedRetry >= BACKGROUND_BATCHES_BEFORE_FAILED_RETRY &&
          isFailedIngestionRetryDue()
        ) {
          await retryFailedIngestionEvents()
        }

        const batchEnd = Math.min(
          backgroundIngestionHead + BACKGROUND_INGESTION_BATCH_SIZE,
          backgroundIngestionEvents.length,
        )
        const events = removeBackgroundIngestionEvents(batchEnd)
        const result = await ingestEvents(events, { queueOnFailure: true })
        if (result.retryableFailureCount > 0 && failedIngestionRetryAttempt === 0) {
          scheduleInitialFailedIngestionRetry()
        }
        backgroundBatchesSinceFailedRetry += 1
      }
      if (allowFailedRetry && failedIngestionEvents.length > 0 && isFailedIngestionRetryDue()) {
        await retryFailedIngestionEvents()
      }
    } catch (e) {
      trackEvent("both", {
        level: "error",
        message: "后台数据上报失败",
        data: { error: String(e) },
        metricName: "plugin.langfuse.ingestion.background.error",
        metricValue: 1,
        tags: { type: "backgroundIngestion", reason: "exception" },
      })
    } finally {
      backgroundIngestionDrainPromise = null
      if (getBackgroundIngestionQueueSize() > 0) {
        scheduleBackgroundIngestionDrain()
      } else if (FAILED_INGESTION_RETRY_ENABLED && failedIngestionEvents.length > 0) {
        scheduleBackgroundIngestionDrain(getFailedIngestionRetryWaitMs())
      }
    }
  })()

  return backgroundIngestionDrainPromise
}

async function flushBackgroundUploads() {
  const drainPromise = drainBackgroundIngestion({ retryFailed: false })
  let timeout: ReturnType<typeof setTimeout> | null = null
  const drained = await Promise.race([
    drainPromise.then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), FLUSH_BACKGROUND_UPLOAD_TIMEOUT_MS)
    }),
  ])
  if (timeout) clearTimeout(timeout)

  if (!drained && getBackgroundIngestionQueueSize() > 0) {
    backgroundIngestionEvents = []
    backgroundIngestionHead = 0
    backgroundIngestionBytes = 0
    pendingBackgroundUpdateEvents.clear()
    // 退出时直接丢弃尚未上传的 event，避免下次启动重传。
  }
}

function traceEventBody(batch: TraceBatch) {
  return {
    id: batch.id,
    name: batch.name,
    sessionId: batch.sessionId,
    input: batch.input,
    output: batch.output ?? "",
    tags: batch.tags,
    metadata: batch.metadata,
    userId: userIdMetadata,
    version: VERSION,
  }
}

function enqueueTraceUpsert(batch: TraceBatch) {
  const body = traceEventBody(batch)
  const snapshot = JSON.stringify(body)
  if (lastEnqueuedTraceSnapshots.get(batch.id) === snapshot) return

  const type = uploadedTraceIds.has(batch.id) ? "trace-update" : "trace-create"
  const event = buildIngestionEvent(type, body)
  trackEvent("metric", {
    metricName: "plugin.langfuse.trace.ingestion.enqueued",
    metricValue: 1,
    tags: ingestionDiagnosticTags([event], {
      node: "traceUpsert",
      action: "enqueue_ingestion_event",
      status: "scheduled",
      sessionId: batch.sessionId,
      traceId: batch.id,
    }),
  })
  scheduleBackgroundIngestion([event])
  lastEnqueuedTraceSnapshots.set(batch.id, snapshot)
  uploadedTraceIds.add(batch.id)
}

function flushPendingTraceUpsert(traceId: string) {
  const batch = pendingTraceUpserts.get(traceId)
  if (!batch) return

  pendingTraceUpserts.delete(traceId)
  enqueueTraceUpsert(batch)
}

function flushAllPendingTraceUpserts() {
  if (traceUpsertTimer) {
    clearTimeout(traceUpsertTimer)
    traceUpsertTimer = null
  }

  for (const traceId of [...pendingTraceUpserts.keys()]) {
    flushPendingTraceUpsert(traceId)
  }
}

function upsertTraceImmediately(batch: TraceBatch, immediate = false) {
  pendingTraceUpserts.set(batch.id, batch)
  if (immediate) {
    flushPendingTraceUpsert(batch.id)
    return
  }
  if (traceUpsertTimer) return

  traceUpsertTimer = setTimeout(() => {
    traceUpsertTimer = null
    for (const traceId of [...pendingTraceUpserts.keys()]) {
      flushPendingTraceUpsert(traceId)
    }
  }, TRACE_UPSERT_DEBOUNCE_MS)
}

function generationEventBody(gen: GenerationData) {
  const modelMetadata = gen.metadata?.model ?? {}
  return {
    id: gen.id,
    traceId: gen.traceId,
    name: gen.name,
    model: gen.model,
    selectedModel: modelMetadata.selectedModel,
    resolvedModel: modelMetadata.resolvedModel,
    modelParameters: gen.modelParameters,
    input: gen.input,
    output: gen.output,
    usage: gen.usage,
    metadata: gen.metadata,
    tags: gen.tags,
    startTime: gen.startTime,
    endTime: gen.endTime,
    completionStartTime: gen.completionStartTime,
    parentObservationId: gen.parentObservationId,
  }
}

function createGenerationImmediately(gen: GenerationData) {
  gen.metadata = withTraceSkillInfo(gen.traceId, gen.metadata)
  rememberObservationSkillInfoCount(gen.traceId, gen.id)
  const outgoingGeneration: GenerationData = {
    ...gen,
    metadata: withoutObservationCompletionFields(gen.metadata),
  }
  scheduleBackgroundIngestion([
    buildIngestionEvent("generation-create", generationEventBody(outgoingGeneration), gen.startTime),
  ])
}

function updateGenerationImmediately(traceId: string, genId: string, updates: Partial<GenerationData>) {
  const normalizedUpdates =
    updates.metadata !== undefined
      ? { ...updates, metadata: withTraceSkillInfoForObservationUpdate(traceId, genId, updates.metadata) }
      : updates
  // A generation can be updated again after it has completed (for example when
  // a subagent is reparented). Preserve the terminal time in every later
  // update: some ingestion implementations otherwise use the event timestamp
  // as the end boundary for an update that omits endTime.
  const existingGeneration = traceBatches.get(traceId)?.generations.find((generation) => generation.id === genId)
  // Pending generation updates are coalesced by ID and the newest event
  // replaces the older one. Carry the current mutable observation state in
  // every update so a later text/reparent update cannot discard usage or other
  // terminal fields from a still-queued step-finish update.
  const preservedState: Partial<GenerationData> = existingGeneration
    ? {
        ...(existingGeneration.parentObservationId
          ? { parentObservationId: existingGeneration.parentObservationId }
          : {}),
        ...(existingGeneration.input !== undefined ? { input: existingGeneration.input } : {}),
        ...(existingGeneration.output !== undefined ? { output: existingGeneration.output } : {}),
        ...(existingGeneration.endTime ? { endTime: existingGeneration.endTime } : {}),
        ...(existingGeneration.completionStartTime
          ? { completionStartTime: existingGeneration.completionStartTime }
          : {}),
        ...(existingGeneration.usage ? { usage: existingGeneration.usage } : {}),
        modelParameters: existingGeneration.modelParameters,
        metadata: existingGeneration.metadata,
        tags: existingGeneration.tags,
      }
    : {}
  const effectiveUpdates = { ...preservedState, ...normalizedUpdates }
  const outgoingUpdates =
    effectiveUpdates.metadata !== undefined
      ? { ...effectiveUpdates, metadata: withoutObservationCompletionFields(effectiveUpdates.metadata) }
      : effectiveUpdates
  const endTime = effectiveUpdates.endTime
  const modelMetadata = effectiveUpdates.metadata?.model ?? {}
  scheduleBackgroundIngestion([
    buildIngestionEvent(
      "generation-update",
      {
        id: genId,
        traceId,
        selectedModel: modelMetadata.selectedModel,
        resolvedModel: modelMetadata.resolvedModel,
        ...outgoingUpdates,
        ...(endTime ? { endTime } : {}),
      },
      endTime,
    ),
  ])
}

function spanEventBody(span: SpanData) {
  return {
    id: span.id,
    traceId: span.traceId,
    parentObservationId: span.parentObservationId,
    name: span.name,
    input: span.input,
    output: span.output,
    metadata: span.metadata,
    tags: span.tags,
    startTime: span.startTime,
    endTime: span.endTime,
    level: span.level,
  }
}

function buildObservationCompletionMetadata(
  metadata: Record<string, any>,
  source: "step-finish" | "message.part.updated" | "tool.execute.after" | "session.idle",
  completedAt = new Date().toISOString(),
) {
  const nodeType = metadata?.nodeType
  return {
    ...metadata,
    ...(nodeType === "subagent"
      ? {
          agentCompleted: true,
          agentCompletionSource: source,
        }
      : {}),
    observationCompleted: true,
    observationCompletionSource: source,
    observationCompletionStatus: "success",
    observationCompletedAt: completedAt,
  }
}

function emitGenerationObservationCompleted(g: GenInfo) {
  if (hasCompletedObservation(g.traceId, g.genId)) return false
  const generation = traceBatches.get(g.traceId)?.generations.find((item) => item.id === g.genId)
  if (!generation?.endTime) return false

  const completedGeneration: GenerationData = {
    ...generation,
    metadata: buildObservationCompletionMetadata(
      generation.metadata,
      "step-finish",
      generation.endTime,
    ),
  }
  if (!markCompletedObservation(g.traceId, g.genId)) return false
  scheduleBackgroundIngestion([
    buildIngestionEvent(
      "generation-update",
      generationEventBody(completedGeneration),
      completedGeneration.endTime,
    ),
  ])
  return true
}

function emitSpanObservationCompleted(
  traceId: string,
  spanId: string,
  source: "message.part.updated" | "tool.execute.after" | "session.idle",
) {
  if (hasCompletedObservation(traceId, spanId)) return false
  const span = traceBatches.get(traceId)?.spans.find((item) => item.id === spanId)
  if (!span?.endTime || !hasOwn(span, "output")) return false

  const completedSpan: SpanData = {
    ...span,
    metadata: buildObservationCompletionMetadata(span.metadata, source, span.endTime),
  }
  if (!markCompletedObservation(traceId, spanId)) return false
  scheduleBackgroundIngestion([
    buildIngestionEvent("span-update", spanEventBody(completedSpan), completedSpan.endTime),
  ])
  return true
}

function createSpanImmediately(span: SpanData) {
  span.metadata = withTraceSkillInfo(span.traceId, span.metadata)
  rememberObservationSkillInfoCount(span.traceId, span.id)
  const outgoingSpan: SpanData = {
    ...span,
    metadata: withoutObservationCompletionFields(span.metadata),
  }
  scheduleBackgroundIngestion([buildIngestionEvent("span-create", spanEventBody(outgoingSpan), span.startTime)])
}

function updateSpanImmediately(traceId: string, spanId: string, updates: Partial<SpanData>) {
  const normalizedUpdates =
    updates.metadata !== undefined
      ? { ...updates, metadata: withTraceSkillInfoForObservationUpdate(traceId, spanId, updates.metadata) }
      : updates
  const outgoingUpdates =
    normalizedUpdates.metadata !== undefined
      ? { ...normalizedUpdates, metadata: withoutObservationCompletionFields(normalizedUpdates.metadata) }
      : normalizedUpdates
  // Do not let a late metadata/parent update reopen a completed tool span.
  // Keep both the body endTime and ingestion timestamp on the original end.
  const existingSpan = traceBatches.get(traceId)?.spans.find((span) => span.id === spanId)
  const endTime = normalizedUpdates.endTime ?? existingSpan?.endTime
  scheduleBackgroundIngestion([
    buildIngestionEvent(
      "span-update",
      { id: spanId, traceId, ...outgoingUpdates, ...(endTime ? { endTime } : {}) },
      endTime,
    ),
  ])
}

function hasOwn(obj: any, key: string) {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key)
}

function getToolPartCompletedAt(part: any, eventTime?: any): Date {
  // Message-part events carry the server-side event timestamp. Prefer it over
  // handler time: the plugin's async event queue can be delayed by a long run.
  return getPartTimestamp(part, "end") ?? getEventTimestamp(eventTime) ?? new Date()
}

function stringifyToolOutput(output: any) {
  if (typeof output === "string") return output
  try {
    const json = JSON.stringify(output)
    return json === undefined ? String(output) : json
  } catch {
    return String(output)
  }
}

function truncateObservedText(text: string, maxLength = MAX_OBSERVED_TEXT_LENGTH) {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}...[truncated ${text.length - maxLength} chars]`
}

function toSpanOutput(output: any) {
  if (output === undefined) return undefined
  if (output === null) return null
  return truncateObservedText(stringifyToolOutput(output))
}

function getToolCallId(value: any): string | undefined {
  const id = value?.callID ?? value?.toolCallID ?? value?.tool_call_id ?? value?.id
  return id === undefined || id === null || id === "" ? undefined : String(id)
}

function isMeaningfulToolOutput(output: any) {
  if (output === undefined || output === null) return false
  if (typeof output === "string") return output.length > 0
  if (Array.isArray(output)) return output.length > 0
  return true
}

function findUnresolvedToolCall(
  sessionId: string | undefined,
  traceId: string | undefined,
  toolName: string | undefined,
) {
  for (const [callID, info] of toolCallInfos) {
    if (sessionId && info.sessionId !== sessionId) continue
    if (traceId && info.traceId !== traceId) continue
    if (toolName && info.toolName && info.toolName !== toolName) continue

    const span = traceBatches.get(info.traceId)?.spans.find((s) => s.id === info.spanId)
    if (!span || span.output === undefined || span.output === null) return { callID, info }
  }
  return undefined
}

function findUnresolvedToolSpan(
  sessionId: string | undefined,
  traceId: string | undefined,
  toolName: string | undefined,
) {
  const sessionSpanCandidates = sessionId ? [...(sessionSpanIds.get(sessionId) ?? [])] : []
  const traceIds = traceId ? [traceId] : [...traceBatches.keys()]

  for (const tid of traceIds) {
    const batch = traceBatches.get(tid)
    if (!batch) continue

    const spanIds = sessionSpanCandidates.length > 0 ? sessionSpanCandidates : batch.spans.map((span) => span.id)
    for (const spanId of spanIds) {
      const span = batch.spans.find((s) => s.id === spanId)
      if (!span) continue
      if (span.metadata?.spanKind !== "TOOL") continue
      if (toolName && span.metadata?.input?.tool && span.metadata.input.tool !== toolName) continue
      if (span.endTime && span.output !== undefined && span.output !== null) continue
      return { spanId: span.id, traceId: tid, span }
    }
  }

  return undefined
}

async function updateToolSpanOutput(traceId: string, spanId: string, endTime: Date, snapshot: ToolResultSnapshot) {
  const existingSpan = traceBatches.get(traceId)?.spans.find((span) => span.id === spanId)
  const spanOutput = toSpanOutput(snapshot.output)
  const spanUpdates: Partial<SpanData> = {
    ...(spanOutput !== undefined ? { output: spanOutput } : {}),
    // A completed tool result can be observed more than once: first from the
    // message part and again when its result is included in the next LLM input.
    // Keep the first completion time so a delayed duplicate does not inflate the
    // tool duration.
    endTime: existingSpan?.endTime ?? endTime.toISOString(),
    level: snapshot.output === null ? "ERROR" : "DEFAULT",
    metadata: {
      ...(existingSpan?.metadata || {}),
      spanKind: "TOOL",
      nodeType: existingSpan?.metadata?.nodeType || "tool",
      ...(snapshot.toolStatus ? { toolStatus: snapshot.toolStatus } : {}),
      ...(snapshot.toolPartCompleted !== undefined ? { toolPartCompleted: snapshot.toolPartCompleted } : {}),
      ...(snapshot.toolCompletionSource ? { toolCompletionSource: snapshot.toolCompletionSource } : {}),
      tags: OBSERVATION_TAGS,
      output: {
        title: snapshot.title,
        output: snapshot.output,
        metadata: snapshot.metadata,
      },
      ...baseMetadata(),
    },
  }

  updateSpanInBatch(traceId, spanId, spanUpdates)
  updateSpanImmediately(traceId, spanId, spanUpdates)
  tryCompleteToolObservation(traceId, spanId)
}

function tryCompleteToolObservation(traceId: string, spanId: string) {
  const span = traceBatches.get(traceId)?.spans.find((item) => item.id === spanId)
  if (!span?.endTime || !hasOwn(span, "output")) return false

  const metadata = span.metadata ?? {}
  if (
    metadata.nodeType === "tool" &&
    metadata.toolPartCompleted === true &&
    metadata.toolAfterReceived === true &&
    metadata.toolCompletionSource === "message.part.updated"
  ) {
    return emitSpanObservationCompleted(traceId, spanId, "message.part.updated")
  }

  if (
    metadata.nodeType === "skill" &&
    metadata.toolAfterReceived === true &&
    metadata.toolCompletionSource === "tool.execute.after"
  ) {
    return emitSpanObservationCompleted(traceId, spanId, "tool.execute.after")
  }

  return false
}

function cleanupToolCallIfCompleted(callID: string, traceId?: string) {
  const callInfo = toolCallInfos.get(callID)
  const spanId = callInfo?.spanId ?? toolSpanIds.get(callID)
  const resolvedTraceId = callInfo?.traceId ?? traceId
  if (!spanId || !resolvedTraceId || !hasCompletedObservation(resolvedTraceId, spanId)) return
  toolSpanIds.delete(callID)
  toolCallInfos.delete(callID)
  toolResultSnapshots.delete(callID)
}

async function captureToolResultsFromMessages(messages: any[]) {
  for (const message of messages) {
    const sessionId = message.info?.sessionID || currentSessionId
    for (const part of message.parts || []) {
      const callID = getToolCallId(part)
      if (part?.type !== "tool" || !callID || part.state?.status !== "completed" || !hasOwn(part.state, "output")) {
        continue
      }

      const snapshot = {
        output: part.state.output,
        metadata: part.metadata,
        title: part.title,
        toolStatus: "completed",
        toolPartCompleted: true,
        toolCompletionSource: "message.part.updated",
      }
      toolResultSnapshots.set(callID, snapshot)
      await updateToolSpanOutputFromSnapshot(
        callID,
        sessionId ? sessionToTrace.get(sessionId) : currentTraceId,
        snapshot.completedAt,
        snapshot,
      )
    }
  }
}

async function captureToolResultsFromLLMInputMessages(messages: any[], sessionId: string, traceId: string) {
  const pendingToolCalls: Array<{ id?: string; name?: string }> = []

  for (const message of messages) {
    if (Array.isArray(message?.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        pendingToolCalls.push({
          id: getToolCallId(toolCall),
          name: toolCall?.function?.name || toolCall?.name,
        })
      }
    }

    if (message?.role !== "tool" || !isMeaningfulToolOutput(message.content)) continue

    const pendingToolCall = pendingToolCalls.shift()
    const toolName = message.name || message.tool || pendingToolCall?.name
    const callID =
      getToolCallId(message) ?? pendingToolCall?.id ?? findUnresolvedToolCall(sessionId, traceId, toolName)?.callID

    const snapshot = {
      output: message.content,
      metadata: { source: "llm-input-message" },
      title: toolName,
      completedAt: callID ? toolResultSnapshots.get(callID)?.completedAt : undefined,
    }
    if (callID) {
      toolResultSnapshots.set(callID, snapshot)
      const updated = await updateToolSpanOutputFromSnapshot(callID, traceId, new Date(), snapshot)
      if (updated) continue
    }

    const unresolvedSpan = findUnresolvedToolSpan(sessionId, traceId, toolName)
    if (unresolvedSpan) {
      await updateToolSpanOutput(unresolvedSpan.traceId, unresolvedSpan.spanId, new Date(), snapshot)
    }
  }
}

function captureToolResultFromConvertedMessage(message: any, part: any) {
  const callID = getToolCallId(part)
  if (callID) message.tool_call_id = callID
  return message
}

async function updateToolSpanOutputFromSnapshot(
  callID: string,
  traceId: string | undefined,
  endTime: Date,
  snapshot: ToolResultSnapshot,
) {
  const callInfo = toolCallInfos.get(callID)
  const spanId = callInfo?.spanId ?? toolSpanIds.get(callID)
  const resolvedTraceId = callInfo?.traceId ?? traceId
  if (!spanId || !resolvedTraceId) return false

  await updateToolSpanOutput(resolvedTraceId, spanId, snapshot.completedAt ?? endTime, snapshot)
  cleanupToolCallIfCompleted(callID, resolvedTraceId)
  return true
}

function normalizeUsage(tokens: any):
  | {
      input: number
      output: number
      total: number
      details?: {
        input: number
        cacheRead: number
        cacheWrite: number
        output: number
        reasoning: number
      }
    }
  | undefined {
  if (!tokens || typeof tokens !== "object") return undefined

  const toTokenNumber = (...values: any[]) => {
    for (const value of values) {
      if (value === undefined || value === null || typeof value === "object") continue
      const n = Number(value)
      if (Number.isFinite(n)) return n
    }
    return undefined
  }

  const input = toTokenNumber(
    tokens.input,
    tokens.input?.total,
    tokens.input?.tokens,
    tokens.input?.count,
    tokens.input?.uncached,
    tokens.prompt?.total,
    tokens.prompt?.tokens,
    tokens.inputTokens,
    tokens.promptTokens,
    tokens.prompt_tokens,
    tokens.input_tokens,
    tokens.usage?.input,
    tokens.usage?.inputTokens,
    tokens.usage?.promptTokens,
    tokens.usage?.prompt_tokens,
    tokens.usage?.input_tokens,
  )
  const output = toTokenNumber(
    tokens.output,
    tokens.output?.total,
    tokens.output?.tokens,
    tokens.output?.count,
    tokens.output?.visible,
    tokens.completion?.total,
    tokens.completion?.tokens,
    tokens.outputTokens,
    tokens.completionTokens,
    tokens.completion_tokens,
    tokens.output_tokens,
    tokens.usage?.output,
    tokens.usage?.outputTokens,
    tokens.usage?.completionTokens,
    tokens.usage?.completion_tokens,
    tokens.usage?.output_tokens,
  )
  const total = toTokenNumber(
    tokens.total,
    tokens.totalTokens,
    tokens.total_tokens,
    tokens.usage?.total,
    tokens.usage?.totalTokens,
    tokens.usage?.total_tokens,
  )
  const reasoning = toTokenNumber(
    tokens.reasoning,
    tokens.reasoning?.total,
    tokens.reasoning?.tokens,
    tokens.output?.reasoning,
    tokens.output?.reasoningTokens,
    tokens.output?.reasoning_tokens,
    tokens.reasoningTokens,
    tokens.reasoning_tokens,
    tokens.output_tokens_details?.reasoning_tokens,
    tokens.usage?.reasoning,
    tokens.usage?.reasoningTokens,
    tokens.usage?.reasoning_tokens,
    tokens.usage?.output_tokens_details?.reasoning_tokens,
  )
  const cacheRead = toTokenNumber(
    tokens.cache?.read,
    tokens.input?.cache?.read,
    tokens.input?.cacheRead,
    tokens.input?.cache_read,
    tokens.input?.cacheReadTokens,
    tokens.input?.cache_read_tokens,
    tokens.cacheRead,
    tokens.cache_read,
    tokens.cacheReadTokens,
    tokens.cache_read_tokens,
    tokens.cache_read_input_tokens,
    tokens.usage?.cache?.read,
    tokens.usage?.cacheRead,
    tokens.usage?.cache_read,
    tokens.usage?.cacheReadTokens,
    tokens.usage?.cache_read_tokens,
    tokens.usage?.cache_read_input_tokens,
  )
  const cacheWrite = toTokenNumber(
    tokens.cache?.write,
    tokens.input?.cache?.write,
    tokens.input?.cacheWrite,
    tokens.input?.cache_write,
    tokens.input?.cacheWriteTokens,
    tokens.input?.cache_write_tokens,
    tokens.cacheWrite,
    tokens.cache_write,
    tokens.cacheWriteTokens,
    tokens.cache_write_tokens,
    tokens.cache_creation_input_tokens,
    tokens.usage?.cache?.write,
    tokens.usage?.cacheWrite,
    tokens.usage?.cache_write,
    tokens.usage?.cacheWriteTokens,
    tokens.usage?.cache_write_tokens,
    tokens.usage?.cache_creation_input_tokens,
  )

  if (
    input === undefined &&
    output === undefined &&
    total === undefined &&
    reasoning === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined
  }

  const uncachedInput = input ?? 0
  const normalizedCacheRead = cacheRead ?? 0
  const normalizedCacheWrite = cacheWrite ?? 0
  const visibleOutput = output ?? 0
  const normalizedReasoning = reasoning ?? 0
  const normalizedInput = uncachedInput + normalizedCacheRead + normalizedCacheWrite
  const normalizedOutput = visibleOutput + normalizedReasoning
  const computedTotal = normalizedInput + normalizedOutput
  const normalizedTotal = total ?? computedTotal

  if (
    ![
      uncachedInput,
      normalizedCacheRead,
      normalizedCacheWrite,
      visibleOutput,
      normalizedReasoning,
      normalizedInput,
      normalizedOutput,
      normalizedTotal,
    ].every(Number.isFinite)
  ) {
    return undefined
  }

  return {
    input: normalizedInput,
    output: normalizedOutput,
    total: Math.max(normalizedTotal, computedTotal),
    details: {
      input: uncachedInput,
      cacheRead: normalizedCacheRead,
      cacheWrite: normalizedCacheWrite,
      output: visibleOutput,
      reasoning: normalizedReasoning,
    },
  }
}

function toOutputUsage(usage?: { input: number; output: number; total: number }) {
  if (!usage) return undefined
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    total_tokens: usage.total,
  }
}

function orderedGenerationTextParts(g: GenInfo) {
  return [...g.textPartSnapshots.values()].sort((a, b) => a.sequence - b.sequence)
}

function generationSnapshotText(g: GenInfo, type: "text" | "reasoning") {
  return orderedGenerationTextParts(g)
    .filter((part) => part.type === type && part.text)
    .map((part) => part.text)
    .join(type === "text" ? "\n\n" : "\n")
}

function updateGenerationTextPart(
  g: GenInfo,
  partId: string,
  type: GenerationTextPartSnapshot["type"],
  text: string,
  options?: { delta?: boolean; complete?: boolean },
) {
  const existing = g.textPartSnapshots.get(partId)
  if (!existing) {
    g.textPartSnapshots.set(partId, {
      partId,
      type,
      text,
      sequence: ++g.textPartSequence,
      complete: !!options?.complete,
    })
    return true
  }

  const previous = { ...existing }
  if (type !== "unknown") existing.type = type

  if (options?.delta) {
    // Once a complete snapshot/hook value exists it already contains every
    // delta. Late bus delivery must not append those tokens a second time.
    if (!existing.complete) existing.text += text
  } else if (!existing.complete || options?.complete) {
    // part.updated is a full snapshot, not a delta. An initial empty snapshot
    // may race behind already-received deltas, so it must not erase them.
    if (text || !existing.text) {
      if (!options?.complete && existing.text.startsWith(text) && existing.text.length > text.length) {
        // Ignore an older cumulative snapshot that arrived after newer deltas.
      } else {
        existing.text = text
      }
    }
  }

  if (options?.complete) existing.complete = true
  return (
    previous.type !== existing.type ||
    previous.text !== existing.text ||
    previous.complete !== existing.complete
  )
}

function buildGenerationText(g: GenInfo) {
  const legacyTextContent = g.parts
    .filter((p) => !p.startsWith("Tool Call:") && !p.startsWith("Tool Result:") && !p.startsWith("Reasoning:"))
    .join("\n\n")
  const legacyReasonText = g.parts
    .filter((p) => p.startsWith("Reasoning:"))
    .map((p) => p.replace(/^Reasoning: /, ""))
    .join("\n")
  const snapshotText = generationSnapshotText(g, "text")
  const snapshotReasoning = generationSnapshotText(g, "reasoning")

  // experimental.text.complete is the authoritative visible response. Part
  // snapshots remain the fallback for providers/versions that skip the hook.
  const textContent = g.output || snapshotText || legacyTextContent
  const reasonText = snapshotReasoning || legacyReasonText

  const combinedText = reasonText ? `<think>\n${reasonText}\n</think>\n\n${textContent}` : textContent
  return combinedText || ""
}

function syncCompletedVisibleText(g: GenInfo) {
  const visibleText = generationSnapshotText(g, "text")
  if (visibleText) g.output = visibleText
}

function refreshFinalizedGenerationText(g: GenInfo) {
  if (!g.finalOutput) return

  const text = buildGenerationText(g)
  if (g.finalOutput.text === text) return

  const structuredOutput = { ...g.finalOutput, text }
  g.finalOutput = structuredOutput
  const existingGeneration = traceBatches.get(g.traceId)?.generations.find((generation) => generation.id === g.genId)
  const generationUpdates: Partial<GenerationData> = {
    // Background generation updates are coalesced by observation ID. Include
    // every terminal field here so this late text repair can safely replace a
    // still-queued step-finish update without dropping usage or finish data.
    ...(existingGeneration?.endTime ? { endTime: existingGeneration.endTime } : {}),
    ...(existingGeneration?.completionStartTime
      ? { completionStartTime: existingGeneration.completionStartTime }
      : {}),
    ...(existingGeneration?.usage ? { usage: existingGeneration.usage } : {}),
    ...(existingGeneration?.modelParameters
      ? { modelParameters: existingGeneration.modelParameters }
      : {}),
    ...(existingGeneration?.tags ? { tags: existingGeneration.tags } : {}),
    output: JSON.stringify(structuredOutput, null, 2),
    metadata: {
      ...(existingGeneration?.metadata ?? {}),
      output: structuredOutput,
    },
  }
  updateGenerationInBatch(g.traceId, g.genId, generationUpdates)
  updateGenerationImmediately(g.traceId, g.genId, generationUpdates)
}

function isGenerationReadyForCompletion(g: GenInfo) {
  if (!g.finalOutput || !g.hasUsage) return false
  const finishReason = g.finalOutput.finish_reason
  if (!finishReason || finishReason === "unknown") return false
  if (finishReason === "tool-calls" && g.toolCalls.length === 0) return false
  return orderedGenerationTextParts(g).every((part) => part.complete)
}

function scheduleGenerationObservationCompletion(g: GenInfo) {
  const existingTimer = generationCompletionTimers.get(g.genId)
  if (existingTimer) {
    clearTimeout(existingTimer)
    generationCompletionTimers.delete(g.genId)
  }
  if (hasCompletedObservation(g.traceId, g.genId) || !isGenerationReadyForCompletion(g)) return

  const timer = setTimeout(() => {
    generationCompletionTimers.delete(g.genId)
    if (isGenerationReadyForCompletion(g)) emitGenerationObservationCompleted(g)
  }, OBSERVATION_COMPLETION_QUIET_MS)
  generationCompletionTimers.set(g.genId, timer)
}

function flushReadyGenerationObservationCompletions(traceId: string, sessionId?: string) {
  for (const g of allGenerations) {
    if (g.traceId !== traceId || (sessionId && g.sessionId !== sessionId)) continue
    if (!isGenerationReadyForCompletion(g)) continue

    const timer = generationCompletionTimers.get(g.genId)
    if (timer) clearTimeout(timer)
    generationCompletionTimers.delete(g.genId)
    emitGenerationObservationCompleted(g)
  }
}

function stripThinkTags(text: string) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
}

function extractTextFromParts(parts: any[]) {
  const textContent = parts
    .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
    .map((p: any) => p.text)
    .join("\n\n")
  const reasonText = parts
    .filter((p: any) => p?.type === "reasoning" && typeof p?.text === "string")
    .map((p: any) => p.text)
    .join("\n")

  return reasonText ? `<think>\n${reasonText}\n</think>\n\n${textContent}` : textContent
}

function getGenerationOutputText(g: GenInfo) {
  const finalText = g.finalOutput?.text
  if (typeof finalText === "string" && finalText.trim()) return finalText

  if (typeof g.output === "string" && g.output.trim()) {
    try {
      const parsed = JSON.parse(g.output)
      if (typeof parsed?.text === "string" && parsed.text.trim()) return parsed.text
    } catch {}
    return g.output
  }
  return buildGenerationText(g)
}

function getGenerationDataOutputText(generation: GenerationData) {
  const metadataText = generation.metadata?.output?.text
  if (typeof metadataText === "string" && metadataText.trim()) return metadataText

  if (typeof generation.output === "string" && generation.output.trim()) {
    try {
      const parsed = JSON.parse(generation.output)
      if (typeof parsed?.text === "string" && parsed.text.trim()) return parsed.text
    } catch {}
    return generation.output
  }

  if (generation.output && typeof generation.output === "object" && typeof generation.output.text === "string") {
    return generation.output.text
  }

  return ""
}

function getFinalTraceOutputFromBatch(batch: TraceBatch) {
  for (const generation of [...batch.generations].reverse()) {
    const text = stripThinkTags(getGenerationDataOutputText(generation))
    if (text) return text
  }

  return undefined
}

function getFinalTraceOutput(traceId: string, preferredSessionId?: string | null) {
  if (preferredSessionId) {
    const assistantOutput = sessionAssistantOutputs.get(preferredSessionId)
    const text = assistantOutput ? stripThinkTags(assistantOutput) : ""
    if (text) return text
  }

  const candidates = allGenerations.filter((g) => g.traceId === traceId)
  const preferredCandidates = preferredSessionId
    ? candidates.filter((g) => g.sessionId === preferredSessionId)
    : candidates
  for (const g of [...preferredCandidates].reverse()) {
    const text = stripThinkTags(getGenerationOutputText(g))
    if (text) return text
  }

  if (preferredSessionId) {
    for (const g of [...candidates.filter((g) => g.sessionId !== preferredSessionId)].reverse()) {
      const text = stripThinkTags(getGenerationOutputText(g))
      if (text) return text
    }
  }

  return undefined
}

async function finalizeGeneration(
  sessionId: string,
  g: GenInfo,
  options?: { tokens?: any; endTime?: Date; removeActive?: boolean; finishReason?: string },
) {
  const endTime = g.responseEndTime ?? options?.endTime ?? new Date()

  if (!g.completionStartTime) {
    g.completionStartTime = endTime
    updateGenerationInBatch(g.traceId, g.genId, {
      completionStartTime: endTime.toISOString(),
    })
  }

  const fullText = buildGenerationText(g)
  const normalizedUsage = normalizeUsage(options?.tokens)
  const usage = normalizedUsage
    ? { input: normalizedUsage.input, output: normalizedUsage.output, total: normalizedUsage.total }
    : { input: 0, output: 0, total: 0 }
  // session.idle is a valid terminal event but does not carry the provider's
  // finish reason. Keep the field present for downstream completion checks.
  const finishReason = options?.finishReason || "unknown"

  const toolCallsOutput = g.toolCalls.map((tc) => ({
    type: "function",
    function: {
      name: tc.name,
      arguments: tc.args || {},
    },
  }))

  const structuredOutput = {
    text: fullText,
    // Keep the response schema stable for text-only completions as well.
    tool_calls: toolCallsOutput,
    usage: toOutputUsage(usage),
    finish_reason: finishReason,
  }

  // The request input was repaired and frozen when this generation became
  // active. Do not rebuild it from the session's latest cache here: a delayed
  // step-finish may run after the next LLM request has already updated that
  // cache.
  const updatedInput = g.input || { messages: [], tools: [] }
  const serializedInput = JSON.stringify(updatedInput, null, 2)
  g.generationData.input = serializedInput

  const generationUpdates: Partial<GenerationData> = {
    input: serializedInput,
    endTime: endTime.toISOString(),
    completionStartTime: g.completionStartTime?.toISOString(),
    usage,
    output: JSON.stringify(structuredOutput, null, 2),
    modelParameters: {
      ...g.modelParameters,
      finish_reason: finishReason,
    },
    tags: [...OBSERVATION_TAGS, `finish_reason:${finishReason}`],
    metadata: {
      spanKind: "LLM",
      model: buildLLMModelMetadata(g),
      output: structuredOutput,
      finish_reason: finishReason,
      usage: {
        unit: "tokens",
        scope: "generation",
        note: "Langfuse generation usage is per LLM call. Input includes uncached input plus cache read/write; output includes visible output plus reasoning.",
        ...(normalizedUsage?.details ? { details: normalizedUsage.details } : {}),
        ...usage,
      },
      tags: OBSERVATION_TAGS,
      ...baseMetadata(),
    },
  }

  updateGenerationInBatch(g.traceId, g.genId, generationUpdates)
  updateGenerationImmediately(g.traceId, g.genId, generationUpdates)

  g.finalOutput = structuredOutput
  g.responseEndTime = endTime
  g.hasUsage = !!normalizedUsage
  scheduleGenerationObservationCompletion(g)
  if (options?.removeActive !== false) {
    deleteActiveGeneration(sessionId, g)
  }
}

/**
 * 批量上传 Trace 数据到 Langfuse（直接 API 方式）
 */
async function flushTrace(traceId: string) {
  const batch = traceBatches.get(traceId)
  if (!batch) {
    // console.log("[langfuse] No batch to flush", { traceId })
    return
  }

  try {
    upsertTraceImmediately(batch, true)
  } catch (e) {
    // console.error("[langfuse] Failed to flush trace", { traceId, error: e })
  }
}

/**
 * 刷新所有未完成的 Trace（兜底机制）
 */
async function flushAllTraces() {
  // console.log("[langfuse] Flushing all traces (fallback)")
  for (const traceId of traceBatches.keys()) {
    await flushTrace(traceId)
  }
  flushAllPendingTraceUpserts()
  await flushBackgroundUploads()
}

function flushAllTracesOnce() {
  if (shutdownFlushCompleted) return Promise.resolve()
  if (shutdownFlushPromise) return shutdownFlushPromise

  shutdownFlushPromise = flushAllTraces().finally(() => {
    shutdownFlushCompleted = true
    shutdownFlushPromise = null
  })
  return shutdownFlushPromise
}

// testagent_change start - install process-level handlers only once across plugin instances
function installProcessHandlers() {
  if (handlersInstalled) return
  handlersInstalled = true

  const flush = async () => {
    await flushAllTracesOnce()
  }

  process.on("beforeExit", flush)
  process.on("SIGINT", flush)
  process.on("SIGTERM", flush)
  process.on("uncaughtException", async (err) => {
    trackEvent("both", {
      level: "error",
      message: "进程未捕获异常",
      data: { error: String(err), stack: (err as Error)?.stack },
      metricName: "plugin.langfuse.process.error",
      metricValue: 1,
      tags: { type: "uncaughtException", reason: "process_error" },
    })
    await flushAllTracesOnce()
    process.exit(1)
  })
  process.on("unhandledRejection", async (reason) => {
    trackEvent("both", {
      level: "error",
      message: "进程未处理的 Promise 拒绝",
      data: { reason: String(reason) },
      metricName: "plugin.langfuse.process.error",
      metricValue: 1,
      tags: { type: "unhandledRejection", reason: "process_error" },
    })
    await flushAllTracesOnce()
  })
}
// testagent_change end

/**
 * 添加 generation 到批次
 */
function addGenerationToBatch(traceId: string, gen: GenerationData) {
  const batch = traceBatches.get(traceId)
  if (batch) {
    gen.metadata = withTraceSkillInfo(traceId, gen.metadata)
    rememberObservationSkillInfoCount(traceId, gen.id)
    batch.generations.push(gen)
  }
}

/**
 * 添加 span 到批次
 */
function addSpanToBatch(traceId: string, span: SpanData) {
  const batch = traceBatches.get(traceId)
  if (batch) {
    span.metadata = withTraceSkillInfo(traceId, span.metadata)
    rememberObservationSkillInfoCount(traceId, span.id)
    batch.spans.push(span)
  }
}

/**
 * 更新批次中的 generation
 */
function updateGenerationInBatch(traceId: string, genId: string, updates: Partial<GenerationData>) {
  const batch = traceBatches.get(traceId)
  if (!batch) return

  const idx = batch.generations.findIndex((g) => g.id === genId)
  if (idx !== -1) {
    const normalizedUpdates =
      updates.metadata !== undefined
        ? { ...updates, metadata: withTraceSkillInfoForObservationUpdate(traceId, genId, updates.metadata) }
        : updates
    batch.generations[idx] = { ...batch.generations[idx], ...normalizedUpdates } as GenerationData
  }
}

/**
 * 更新批次中的 span
 */
function updateSpanInBatch(traceId: string, spanId: string, updates: Partial<SpanData>) {
  const batch = traceBatches.get(traceId)
  if (!batch) return

  const idx = batch.spans.findIndex((s) => s.id === spanId)
  if (idx !== -1) {
    const normalizedUpdates =
      updates.metadata !== undefined
        ? { ...updates, metadata: withTraceSkillInfoForObservationUpdate(traceId, spanId, updates.metadata) }
        : updates
    batch.spans[idx] = { ...batch.spans[idx], ...normalizedUpdates } as SpanData
  }
}

/**
 * 更新批次中的 trace
 */
function updateTraceBatch(traceId: string, updates: Partial<TraceBatch>) {
  const batch = traceBatches.get(traceId)
  if (batch) {
    Object.assign(batch, updates)
  }
}

// ==================== 消息格式转换 ====================

export function convertToLLMMessages(messages: any[]): any[] {
  const result: any[] = []

  for (const m of messages) {
    if (!m.info?.role || !m.parts?.length) continue

    const role = m.info.role
    const name = m.info.name || role

    const textContent: any[] = []
    const toolCalls: any[] = []
    const toolResults: any[] = []
    let textBuffer = ""

    const flushTextBuffer = () => {
      if (!textBuffer) return
      textContent.push({ type: "text", text: textBuffer })
      textBuffer = ""
    }

    for (const p of m.parts) {
      if (p.type === "text") {
        if (typeof p.text === "string") textBuffer += p.text
      } else if (p.type === "reasoning") {
        if (typeof p.text === "string") textBuffer += `<think>\n${p.text}\n</think>\n\n`
      } else if (p.type === "tool") {
        flushTextBuffer()
        if (p.state?.input !== undefined) {
          const toolCall: any = {
            type: "function",
            function: {
              name: p.tool,
              arguments: p.state.input,
            },
          }
          const callID = getToolCallId(p)
          if (callID) toolCall.id = callID
          toolCalls.push(toolCall)
        }
        if (p.state?.status === "completed" && p.state?.output !== undefined) {
          toolResults.push(
            captureToolResultFromConvertedMessage(
              {
                role: "tool",
                name: p.tool,
                content: p.state.output,
              },
              p,
            ),
          )
        } else if (p.state?.status === "error" && p.state?.error) {
          toolResults.push(
            captureToolResultFromConvertedMessage(
              {
                role: "tool",
                name: p.tool,
                content: `Error: ${p.state.error}`,
              },
              p,
            ),
          )
        }
      } else if (p.type === "tool-call") {
        flushTextBuffer()
        const toolCall: any = {
          type: "function",
          function: {
            name: p.name,
            arguments: p.args || {},
          },
        }
        const callID = getToolCallId(p)
        if (callID) toolCall.id = callID
        toolCalls.push(toolCall)
      } else if (p.type === "tool-result") {
        flushTextBuffer()
        toolResults.push(
          captureToolResultFromConvertedMessage(
            {
              role: "tool",
              name: p.name || "",
              content: p.output,
            },
            p,
          ),
        )
      }
    }
    flushTextBuffer()

    const msg: any = { role, name }
    msg.content = textContent.length > 0 ? textContent : null
    if (toolCalls.length > 0) msg.tool_calls = toolCalls

    result.push(msg)

    for (const tr of toolResults) result.push(tr)
  }

  return result
}

function extractFromZodDef(def: Record<string, any>): any {
  const result: Record<string, any> = {}

  if (def.description) result.description = def.description

  switch (def.type) {
    case "object": {
      result.type = "object"
      if (def.shape) {
        result.properties = {}
        for (const [key, val] of Object.entries(def.shape)) {
          result.properties[key] = toJsonSchema(val)
        }
      }
      if (def.required && Array.isArray(def.required)) {
        result.required = def.required
      }
      break
    }
    case "array": {
      result.type = "array"
      if (def.element) result.items = toJsonSchema(def.element)
      if (def.minLength != null) result.minItems = def.minLength
      if (def.maxLength != null) result.maxItems = def.maxLength
      break
    }
    case "string": {
      result.type = "string"
      if (def.minLength != null) result.minLength = def.minLength
      if (def.maxLength != null) result.maxLength = def.maxLength
      if (def.pattern != null) result.pattern = def.pattern
      if (def.format != null) result.format = def.format
      break
    }
    case "number": {
      result.type = "number"
      if (def.minimum != null) result.minimum = def.minimum
      if (def.maximum != null) result.maximum = def.maximum
      break
    }
    case "boolean": {
      result.type = "boolean"
      break
    }
    case "enum": {
      if (def.values) result.enum = def.values
      break
    }
    case "union": {
      result.oneOf = (def.choices || []).map(toJsonSchema)
      break
    }
    case "optional":
    case "nullable": {
      if (def.innerType) return toJsonSchema(def.innerType)
      break
    }
    case "literal": {
      if (def.values) result.const = def.values[0]
      break
    }
    default: {
      // Fallback: try to extract basic type
      if (def.type) result.type = def.type
    }
  }

  return result
}

function extractJsonSchemaKeys(obj: Record<string, any>): any {
  const jsonSchemaKeys = new Set([
    "type",
    "properties",
    "items",
    "required",
    "description",
    "enum",
    "const",
    "default",
    "additionalProperties",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "$ref",
    "$defs",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "format",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "title",
    "examples",
  ])

  const result: Record<string, any> = {}
  for (const [key, val] of Object.entries(obj)) {
    if (jsonSchemaKeys.has(key)) {
      result[key] = typeof val === "object" && val !== null ? extractJsonSchemaKeys(val) : val
    }
  }
  return Object.keys(result).length > 0 ? result : obj
}

/**
 * 构建 LLM 输入
 * @param messages 内部消息数组
 * @param system 系统 prompt 数组
 * @param tools 工具定义数组
 * @returns { json: string, dict: object }
 */
function toJsonSchema(obj: any): any {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(toJsonSchema)

  // Handle Effect Schema objects (have .ast property with _tag)
  if (obj.ast && typeof obj.ast === "object" && obj.ast._tag) {
    try {
      const doc = Schema.toJsonSchemaDocument(obj as Schema.Top)
      return toJsonSchema(doc)
    } catch {
      // Fall through to Zod/extract logic
    }
  }

  const result: Record<string, any> = {}
  const jsonSchemaKeys = [
    "type",
    "properties",
    "items",
    "required",
    "description",
    "enum",
    "const",
    "default",
    "additionalProperties",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "$ref",
    "$defs",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "title",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
  ]

  // If it looks like a Zod schema (has ~standard or def), extract from def
  if ("def" in obj && obj.def && typeof obj.def === "object") {
    const def = obj.def
    // Check if def itself needs recursive cleaning
    if ("shape" in def && def.shape && typeof def.shape === "object") {
      // Object with properties
      result.type = def.type || "object"
      if (def.description) result.description = def.description
      result.properties = {}
      for (const [key, val] of Object.entries(def.shape)) {
        result.properties[key] = toJsonSchema(val)
      }
      if (def.required) result.required = def.required
    } else if ("innerType" in def) {
      // Nullable or optional wrapper
      result.type = def.type || def.innerType?.type || "object"
      if (def.description) result.description = def.description
    } else if (def.type === "array" && "element" in def) {
      result.type = "array"
      if (def.description) result.description = def.description
      result.items = toJsonSchema(def.element)
    } else if (def.type === "enum") {
      result.enum = def.values
      if (def.description) result.description = def.description
    } else {
      // Other zod types, try to extract basic info
      const cleaned = extractJsonSchema(def)
      Object.assign(result, cleaned)
    }
    return { ...result }
  }

  // Not a zod schema, just extract known json schema keys
  return extractJsonSchema(obj)
}

function extractJsonSchema(obj: Record<string, any>): any {
  const result: Record<string, any> = {}
  const jsonSchemaKeys = new Set([
    "type",
    "properties",
    "items",
    "required",
    "description",
    "enum",
    "const",
    "default",
    "additionalProperties",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "$ref",
    "$defs",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "title",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
  ])

  for (const [key, val] of Object.entries(obj)) {
    if (jsonSchemaKeys.has(key)) {
      result[key] = typeof val === "object" && val !== null ? extractJsonSchema(val) : val
    }
  }
  return Object.keys(result).length > 0 ? result : obj
}

/**
 * 构建 LLM 输入
 * @param messages 内部消息数组
 * @param system 系统 prompt 数组
 * @param tools 工具定义数组
 * @returns { json: string, dict: object }
 */
export function buildLLMInput(messages: any[], system: string[], tools: any[]): { json: string; dict: object } {
  const systemMessages = system.map((s) => ({
    role: "system",
    content: s,
  }))
  const formattedMessages = [...systemMessages, ...convertToLLMMessages(messages)]
  const formattedTools = tools.map((t) => {
    if (t.type === "function") return t
    const name = t.name || t.id || t
    return {
      type: "function",
      function: {
        name,
        description: t.description || "",
        // testagent_change: sandbox tool schema is hidden from the LLM
        parameters:
          name === "sandbox"
            ? { type: "object", properties: {} }
            : toJsonSchema(t.parameters || { type: "object", properties: {} }),
      },
    }
  })
  const dict = { messages: formattedMessages, tools: formattedTools }
  return { json: JSON.stringify(dict, null, 2), dict }
}

function getRawMessageId(message: any): string | undefined {
  const id = message?.info?.id ?? message?.info?.messageID ?? message?.messageID ?? message?.id
  return typeof id === "string" && id ? id : undefined
}

export function selectGenerationRequestMessages(cachedMessages: any[], assistantMessageId?: string): any[] {
  if (!assistantMessageId) return cachedMessages

  const assistantBoundary = cachedMessages.findIndex(
    (message) => message?.info?.role === "assistant" && getRawMessageId(message) === assistantMessageId,
  )
  return assistantBoundary >= 0 ? cachedMessages.slice(0, assistantBoundary) : cachedMessages
}

/**
 * Refresh a generation with the latest transformed request messages.
 *
 * Hook ordering differs across OpenCode/TestAgent versions: some invoke
 * chat.params before experimental.chat.messages.transform. Waiting until the
 * generation is activated fixes that one-request lag. If its first concrete
 * event runs after a newer transform, slice at this generation's assistant message;
 * everything before that message is precisely the causal input of this LLM
 * call, while its own assistant/tool output must never be included.
 */
function refreshGenerationInputFromCachedMessages(g: GenInfo): boolean {
  const cachedMessages = llmInputs.get(g.sessionId)
  if (!cachedMessages || cachedMessages.length === 0) return false

  const requestMessages = selectGenerationRequestMessages(cachedMessages, g.assistantMessageId)

  const system = systemPrompts.get(g.sessionId) || []
  const built = buildLLMInput(requestMessages, system, [])
  const updatedInput = {
    messages: (built.dict as any).messages || [],
    // Tool availability belongs to the request captured by chat.params. Do
    // not rebuild it from the global registry, which may contain tools that
    // were filtered out for this agent or changed by a later request.
    tools: g.input?.tools || [],
  }
  const serializedInput = JSON.stringify(updatedInput, null, 2)

  g.input = updatedInput
  g.generationData.input = serializedInput
  return true
}

// testagent_change start - record only active tools in Langfuse LLM input
function activeToolDefs(ids?: string[]) {
  if (!ids) return [...allToolDefs.values()]
  return ids.map((id) => allToolDefs.get(id) ?? { id, description: "", parameters: { type: "object", properties: {} } })
}
// testagent_change end

// ==================== Skill 原始内容缓存 ====================

const skillCache = new Map<string, { raw: string; yaml: Record<string, any>; content: string }>()

function parseFrontmatter(raw: string): { yaml: Record<string, any>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return { yaml: {}, content: raw }

  const yamlBlock = match[1] ?? ""
  const content = match[2] ?? raw
  const yaml: Record<string, any> = {}

  for (const line of yamlBlock.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const kvMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!kvMatch) continue
    const key = kvMatch[1]
    const rawValue = kvMatch[2] ?? ""
    const val = rawValue.trim().replace(/^["']|["']$/g, "")
    yaml[key] = val
  }

  return { yaml, content }
}

function resolveSkillFilePath(dir: string): string | null {
  if (existsSync(`${dir}/SKILL.md`)) {
    return `${dir}/SKILL.md`
  }
  if (existsSync(`${dir}/skill.md`)) {
    return `${dir}/skill.md`
  }
  return null
}

function loadSkillRaw(filePath: string): { raw: string; yaml: Record<string, any>; content: string } | null {
  const cacheKey = `file::${filePath}`
  if (skillCache.has(cacheKey)) return skillCache.get(cacheKey)!

  try {
    const raw = readFileSync(filePath, "utf-8")
    const { yaml, content } = parseFrontmatter(raw)
    const entry = { raw, yaml, content }
    skillCache.set(cacheKey, entry)
    return entry
  } catch {
    return null
  }
}

// ==================== Langfuse API 辅助函数 ====================

async function signup_user(user_id: string, user_name: string, langfuse_host: string, pathName: string|null): Promise<void> {
  let pathNames = null;
  let center = null;
  let teamPath = null;
  let deptPath = null;
  let organizePath = null;
  if (pathName) {
    pathNames = pathName.split("/");
    center = pathNames.find(item => item.includes("中心")) || null;
    teamPath = pathNames.find(item => item.includes("团队")) || null;
    deptPath = pathNames.find(item => item.includes("室")) || null;
    organizePath = pathNames.find(item => item.includes("组")) || null;
  }

  const res = await fetchWithTimeout(`${langfuse_host}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([
      {
        name: `${user_name}/${user_id}`,
        email: `${user_id}${decodeURIComponent(atob("JTQwY21iY2hpbmEuY29t"))}`,
        password: `${user_id}${decodeURIComponent(atob("JTQwY21iY2hpbmEuY29t"))}`,
        center: center,
        teamPath: teamPath,
        deptPath: deptPath,
        organizePath: organizePath,
      },
    ]),
  })
  const resJson = await res.json()
  if (resJson.message === "User created") {
    // console.log(`[langfuse] 注册用户成功:${user_name}/${user_id}`)
  } else {
    // console.error(`[langfuse] 注册用户失败:${JSON.stringify(resJson)}`)
  }
}

async function get_langfuse_login_token(langfuse_host: string, user_id: string): Promise<string> {
  const password = `${user_id}${decodeURIComponent(atob("JTQwY21iY2hpbmEuY29t"))}`
  const email = password.toLowerCase()

  const csrfRes = await fetchWithTimeout(`${langfuse_host}/api/auth/csrf`)
  const csrfJson = await csrfRes.json()
  const csrf_token = csrfJson.csrfToken

  const cookies: Record<string, string> = {}
  csrfRes.headers
    .get("set-cookie")
    ?.split(",")
    .forEach((cookie) => {
      const parts = cookie.trim().split(";")[0].split("=")
      if (parts.length === 2) cookies[parts[0]] = parts[1]
    })
  let csrf_headers = ""
  for (const [key, value] of Object.entries(cookies)) {
    csrf_headers += `${key}=${value};`
  }

  const credentials_body = new URLSearchParams({
    email,
    password,
    callbackUrl: "/",
    redirect: "false",
    turnstileToken: "undefined",
    csrfToken: csrf_token,
    json: "true",
  })

  const credentialsRes = await fetchWithTimeout(`${langfuse_host}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrf_headers,
      Origin: langfuse_host,
      Referer: `${langfuse_host}/auth/sign-in`,
    },
    body: credentials_body,
  })

  const finalCookies: Record<string, string> = {}
  credentialsRes.headers
    .get("set-cookie")
    ?.split(",")
    .forEach((cookie) => {
      const parts = cookie.trim().split(";")[0].split("=")
      if (parts.length === 2) finalCookies[parts[0]] = parts[1]
    })
  let final_cookies = ""
  for (const [key, value] of Object.entries(finalCookies)) {
    final_cookies += `${key}=${value};`
  }
  return final_cookies
}

async function create_organization(session: string, langfuse_host: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(`${langfuse_host}/api/trpc/organizations.create`, {
      method: "POST",
      headers: { Cookie: session, "Content-Type": "application/json" },
      body: JSON.stringify({ json: { name: "TestAgent", appId: "", channel: "testagent" } }),
    })
    const resJson = await res.json()
    const orgId = resJson?.result?.data?.json?.id
    if (orgId) {
      trackEvent("metric", {
        metricName: "plugin.langfuse.api.success",
        metricValue: 1,
        tags: { api: "create_organization", orgId },
      })
    } else {
      trackEvent("both", {
        level: "error",
        message: "创建组织失败，返回数据异常",
        data: { response: JSON.stringify(resJson) },
        metricName: "plugin.langfuse.api.error",
        metricValue: 1,
        tags: { api: "create_organization", reason: "invalid_response" },
      })
    }
    return orgId || null
  } catch (e) {
    trackEvent("both", {
      level: "error",
      message: "创建组织异常",
      data: { error: String(e) },
      metricName: "plugin.langfuse.api.error",
      metricValue: 1,
      tags: { api: "create_organization", reason: "exception" },
    })
    return null
  }
}

async function create_project(
  user_id: string,
  user_name: string,
  org_id: string,
  session: string,
  langfuse_host: string,
): Promise<{ public_key: string; secret_key: string; project_id: string } | null> {
  try {
    let res = await fetchWithTimeout(`${langfuse_host}/api/trpc/projects.create`, {
      method: "POST",
      headers: { Cookie: session, "Content-Type": "application/json" },
      body: JSON.stringify({
        json: { name: `${user_name}/${user_id}`, orgId: org_id, appId: "", techId: "", channel: "testagent" },
      }),
    })
    let resJson = await res.json()
    const project_id = resJson?.result?.data?.json?.id
    if (!project_id) {
      trackEvent("both", {
        level: "error",
        message: "创建项目失败，返回数据异常",
        data: { response: JSON.stringify(resJson) },
        metricName: "plugin.langfuse.api.error",
        metricValue: 1,
        tags: { api: "projects.create", reason: "invalid_response" },
      })
      return null
    }
    trackEvent("metric", {
      metricName: "plugin.langfuse.api.success",
      metricValue: 1,
      tags: { api: "projects.create", projectId: project_id },
    })

    res = await fetchWithTimeout(`${langfuse_host}/api/trpc/projectApiKeys.create`, {
      method: "POST",
      headers: { Cookie: session, "Content-Type": "application/json" },
      body: JSON.stringify({ json: { projectId: project_id } }),
    })
    resJson = await res.json()
    const apiKeyJson = resJson?.result?.data?.json
    const public_key = apiKeyJson?.publicKey
    const secret_key = apiKeyJson?.secretKey
    const createApiKeyStatus = apiKeyJson?.status
    if (createApiKeyStatus === "create apiKey failed") {
      trackEvent("both", {
        level: "error",
        message: "创建项目 API 密钥失败，服务端返回创建失败，将使用兜底密钥",
        data: { projectId: project_id, response: JSON.stringify(resJson) },
        metricName: "plugin.langfuse.api.error",
        metricValue: 1,
        tags: { api: "projectApiKeys.create", reason: "create_api_key_failed" },
      })
      return null
    }
    if (!public_key || !secret_key) {
      trackEvent("both", {
        level: "error",
        message: "创建项目 API 密钥失败，返回数据异常",
        data: { response: JSON.stringify(resJson) },
        metricName: "plugin.langfuse.api.error",
        metricValue: 1,
        tags: { api: "projectApiKeys.create", reason: "invalid_response" },
      })
      return null
    }
    trackEvent("metric", {
      metricName: "plugin.langfuse.api.success",
      metricValue: 1,
      tags: { api: "projectApiKeys.create", projectId: project_id },
    })
    return { public_key, secret_key, project_id }
  } catch (e) {
    trackEvent("both", {
      level: "error",
      message: "创建项目异常",
      data: { error: String(e), userId: user_id, userName: user_name },
      metricName: "plugin.langfuse.api.error",
      metricValue: 1,
      tags: { api: "create_project", reason: "exception" },
    })
    return null
  }
}

type ProjectApiKeys = { public_key: string; secret_key: string; project_id: string }
type LangfuseKeyCache = {
  host: string
  userId: string
  userInfo: string
  projectId: string
  publicKey: string
  secretKey: string
  updatedAt: string
}
type ApiKeyLookupResult =
  | { status: "found"; apiKeys: ProjectApiKeys }
  | { status: "not_found" }
  | { status: "create_api_key_failed" }
  | { status: "error"; error: string }

function getUserInfoKey(user_id: string, user_name: string) {
  return `${user_name}/${user_id}`
}

function cachedProjectKeysFromJson(cache: any, user_id: string, user_name: string, langfuse_host: string): ProjectApiKeys | null {
  const userInfo = getUserInfoKey(user_id, user_name)
  if (
    !cache ||
    typeof cache !== "object" ||
    cache.host !== langfuse_host ||
    cache.userId !== user_id ||
    cache.userInfo !== userInfo ||
    typeof cache.projectId !== "string" ||
    typeof cache.publicKey !== "string" ||
    typeof cache.secretKey !== "string"
  ) {
    return null
  }
  return { public_key: cache.publicKey, secret_key: cache.secretKey, project_id: cache.projectId }
}

function readCachedProjectKeys(user_id: string, user_name: string, langfuse_host: string): ProjectApiKeys | null {
  if (!existsSync(LANGFUSE_KEY_CACHE_FILE)) {
    trackEvent("metric", {
      metricName: "plugin.langfuse.cache.status",
      metricValue: 1,
      tags: { type: "langfuseKeyCache", status: "missing" },
    })
    return null
  }
  try {
    const cache = JSON.parse(readFileSync(LANGFUSE_KEY_CACHE_FILE, "utf-8"))
    const apiKeys = cachedProjectKeysFromJson(cache, user_id, user_name, langfuse_host)
    if (apiKeys) {
      trackEvent("metric", {
        metricName: "plugin.langfuse.cache.success",
        metricValue: 1,
        tags: { type: "langfuseKeyCache", status: "hit", projectId: apiKeys.project_id },
      })
      return apiKeys
    }
    trackEvent("both", {
      level: "warn",
      message: "本地项目 API 密钥缓存不匹配，将重新查询",
      data: { userId: user_id, userName: user_name, file: LANGFUSE_KEY_CACHE_FILE },
      metricName: "plugin.langfuse.cache.error",
      metricValue: 1,
      tags: { type: "langfuseKeyCache", action: "read", reason: "mismatch" },
    })
    return null
  } catch (e) {
    trackEvent("both", {
      level: "error",
      message: "读取本地项目 API 密钥缓存异常",
      data: { error: String(e), file: LANGFUSE_KEY_CACHE_FILE },
      metricName: "plugin.langfuse.cache.error",
      metricValue: 1,
      tags: { type: "langfuseKeyCache", action: "read", reason: "exception" },
    })
    return null
  }
}

function writeCachedProjectKeys(user_id: string, user_name: string, langfuse_host: string, apiKeys: ProjectApiKeys) {
  const cache: LangfuseKeyCache = {
    host: langfuse_host,
    userId: user_id,
    userInfo: getUserInfoKey(user_id, user_name),
    projectId: apiKeys.project_id,
    publicKey: apiKeys.public_key,
    secretKey: apiKeys.secret_key,
    updatedAt: new Date().toISOString(),
  }
  try {
    mkdirSync(dirname(LANGFUSE_KEY_CACHE_FILE), { recursive: true })
    const tmpFile = `${LANGFUSE_KEY_CACHE_FILE}.tmp`
    writeFileSync(tmpFile, JSON.stringify(cache, null, 2), "utf-8")
    try {
      chmodSync(tmpFile, 0o600)
    } catch {}
    renameSync(tmpFile, LANGFUSE_KEY_CACHE_FILE)
    try {
      chmodSync(LANGFUSE_KEY_CACHE_FILE, 0o600)
    } catch {}
    trackEvent("metric", {
      metricName: "plugin.langfuse.cache.success",
      metricValue: 1,
      tags: { type: "langfuseKeyCache", action: "write", projectId: apiKeys.project_id },
    })
  } catch (e) {
    trackEvent("both", {
      level: "error",
      message: "写入本地项目 API 密钥缓存异常",
      data: { error: String(e), file: LANGFUSE_KEY_CACHE_FILE },
      metricName: "plugin.langfuse.cache.error",
      metricValue: 1,
      tags: { type: "langfuseKeyCache", action: "write", reason: "exception" },
    })
  }
}

async function get_apikeys_by_user(
  user_id: string,
  user_name: string,
  langfuse_host: string,
): Promise<ApiKeyLookupResult> {
  try {
    const res = await fetchWithTimeout(`${langfuse_host}/api/trpc/projectApiKeys.byUserInfo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: { userInfo: `${user_name}/${user_id}` } }),
    }, LANGFUSE_KEY_LOOKUP_TIMEOUT_MS)
    if (!res.ok) {
      const text = await readResponseTextSafe(res)
      trackEvent("both", {
        level: "error",
        message: "获取密钥信息失败，接口返回非2xx",
        data: { userId: user_id, userName: user_name, status: res.status, response: text.slice(0, 500) },
        metricName: "plugin.langfuse.api.error",
        metricValue: 1,
        tags: { api: "get_apikeys_by_user", reason: "http_error", status: String(res.status) },
      })
      return { status: "error", error: `http_status_${res.status}` }
    }
    const resJson = await res.json()
    const json = resJson?.result?.data?.json
    const lookupStatus = json?.status
    const public_key = json?.publicKey
    const secret_key = json?.secretKey
    const project_id = json?.projectId
    if (lookupStatus === "found project" && public_key && secret_key && project_id) {
      trackEvent("metric", {
        metricName: "plugin.langfuse.api.success",
        metricValue: 1,
        tags: { api: "get_apikeys_by_user", status: "found", projectId: project_id },
      })
      return { status: "found", apiKeys: { public_key, secret_key, project_id } }
    }
    if (lookupStatus === "not found project") {
      trackEvent("metric", {
        metricName: "plugin.langfuse.api.status",
        metricValue: 1,
        tags: { api: "get_apikeys_by_user", status: "not_found" },
      })
      return { status: "not_found" }
    }
    if (lookupStatus === "create apiKey failed") {
      trackEvent("both", {
        level: "error",
        message: "查询密钥时服务端创建 API 密钥失败，将使用兜底密钥",
        data: { userId: user_id, userName: user_name, response: JSON.stringify(resJson) },
        metricName: "plugin.langfuse.api.error",
        metricValue: 1,
        tags: { api: "get_apikeys_by_user", reason: "create_api_key_failed" },
      })
      return { status: "create_api_key_failed" }
    }
    trackEvent("both", {
      level: "error",
      message: "获取密钥信息失败，返回状态或数据异常",
      data: { userId: user_id, userName: user_name, lookupStatus, response: JSON.stringify(resJson) },
      metricName: "plugin.langfuse.api.error",
      metricValue: 1,
      tags: { api: "get_apikeys_by_user", reason: "invalid_response" },
    })
    return { status: "error", error: "invalid_response" }
  } catch (e) {
    const isTimeout = e instanceof Error && e.name === "AbortError"
    trackEvent("both", {
      level: "error",
      message: isTimeout ? "获取密钥信息超时，将使用兜底密钥" : "获取密钥信息异常",
      data: { error: String(e), userId: user_id, userName: user_name },
      metricName: "plugin.langfuse.api.error",
      metricValue: 1,
      tags: { api: "get_apikeys_by_user", reason: isTimeout ? "timeout" : "exception" },
    })
    return { status: "error", error: isTimeout ? "timeout" : String(e) }
  }
}

async function get_project_apikeys(
  user_id: string,
  user_name: string,
  langfuse_host: string,
  path_name: string | null,
  options?: { allowCreateOnNotFound?: boolean },
): Promise<ProjectApiKeys | null> {
  const lookup = await get_apikeys_by_user(user_id, user_name, langfuse_host)
  if (lookup.status === "found") {
    return lookup.apiKeys
  }
  if (lookup.status !== "not_found") {
    trackEvent("both", {
      level: "warn",
      message: "获取项目 API 密钥未成功，将使用兜底密钥",
      data: { userId: user_id, userName: user_name, status: lookup.status },
      metricName: "plugin.langfuse.api.error",
      metricValue: 1,
      tags: { api: "get_project_apikeys", reason: lookup.status },
    })
    return null
  }
  if (options?.allowCreateOnNotFound === false) {
    trackEvent("metric", {
      metricName: "plugin.langfuse.api.status",
      metricValue: 1,
      tags: { api: "get_project_apikeys", status: "not_found_with_cache" },
    })
    return null
  }
  trackEvent("metric", {
    metricName: "plugin.langfuse.api.status",
    metricValue: 1,
    tags: { api: "get_project_apikeys", status: "create_project_required" },
  })
  await signup_user(user_id, user_name, langfuse_host, path_name)
  const session = await get_langfuse_login_token(langfuse_host, user_id)
  const org_id = await create_organization(session, langfuse_host)
  if (org_id) {
    const result = await create_project(user_id, user_name, org_id, session, langfuse_host)
    if (result?.public_key && result?.secret_key) {
      return result
    }
    trackEvent("both", {
      level: "warn",
      message: "创建项目后仍然获取不到 API 密钥",
      data: { userId: user_id, userName: user_name },
      metricName: "plugin.langfuse.api.error",
      metricValue: 1,
      tags: { api: "create_project", reason: "missing_api_keys_after_create" },
    })
  } else {
    trackEvent("both", {
      level: "warn",
      message: "创建组织失败，无法继续获取 API 密钥",
      data: { userId: user_id, userName: user_name },
      metricName: "plugin.langfuse.api.error",
      metricValue: 1,
      tags: { api: "create_organization", reason: "missing_org_id" },
    })
  }
  return null
}



type ExtendedPluginInput = {
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
  metric?: (...args: any[]) => void;
}

let pluginLog: ExtendedPluginInput['log']
let pluginMetric: ExtendedPluginInput['metric']

// ==================== 共用埋点方法 ====================

/**
 * 埋点类型
 * - 'log': 仅记录日志
 * - 'metric': 仅记录指标
 * - 'both': 同时记录日志和指标
 */
type TrackType = 'log' | 'metric' | 'both'

type LogTrackOptions = {
  level?: 'debug' | 'info' | 'warn' | 'error'
  message: string
  data?: Record<string, unknown>
}

type MetricTrackOptions = {
  metricName: string
  metricValue: number
  tags?: Record<string, string | number | boolean>
}

type BothTrackOptions = LogTrackOptions & MetricTrackOptions
type TrackOptions = LogTrackOptions | MetricTrackOptions | BothTrackOptions

function diagnosticTagValue(values: string[]) {
  const distinctValues = [...new Set(values.filter(Boolean))]
  const value = distinctValues.join(",")
  return value.length <= MAX_DIAGNOSTIC_TAG_VALUE_LENGTH ? value : value.slice(0, MAX_DIAGNOSTIC_TAG_VALUE_LENGTH)
}

function ingestionDiagnosticTags(
  events: any[],
  tags: Record<string, string | number | boolean> = {},
): Record<string, string | number | boolean> {
  const limitedEvents = events.slice(0, MAX_DIAGNOSTIC_BATCH_EVENT_IDS)
  const traceIds = limitedEvents.map((event) => String(event?.body?.traceId || event?.body?.id || ""))
  const eventIds = limitedEvents.map((event) => String(event?.id || ""))
  const eventTypes = limitedEvents.map((event) => String(event?.type || "unknown"))
  return {
    ...tags,
    runtimeId: PLUGIN_RUNTIME_ID,
    pluginInstanceId: currentPluginInstanceId,
    eventCount: String(events.length),
    traceCount: String(new Set(traceIds.filter(Boolean)).size),
    traceIds: diagnosticTagValue(traceIds),
    eventIds: diagnosticTagValue(eventIds),
    eventTypes: diagnosticTagValue(eventTypes),
    eventListTruncated: events.length > limitedEvents.length,
  }
}

/**
 * 共用埋点方法
 * @param type - 埋点类型：'log' | 'metric' | 'both'
 * @param options - 埋点选项
 */
function trackEvent(type: 'log', options: LogTrackOptions): void
function trackEvent(type: 'metric', options: MetricTrackOptions): void
function trackEvent(type: 'both', options: BothTrackOptions): void
function trackEvent(type: TrackType, options: TrackOptions): void {

  // 记录日志
  if (type === 'log' || type === 'both') {
    const { level = 'info', message, data } = options as LogTrackOptions
    pluginLog?.(level, message, { ...data, service: "langfuse" })
  }

  // 记录指标
  if (type === 'metric' || type === 'both') {
    const { metricName, metricValue, tags } = options as MetricTrackOptions
    const metricPayload = {
      ...tags,
      service: "langfuse",
      metricName,
      value: metricValue,
    }
    if (pluginMetric?.length === 1) {
      pluginMetric(metricPayload)
    } else {
      pluginMetric?.(metricName, metricValue, metricPayload)
    }
  }
}

function scheduleSessionIdleFinalization(sessionId: string, traceId: string) {
  if (pendingIdleFinalizations.has(sessionId)) return
  pendingIdleFinalizations.add(sessionId)

  setTimeout(() => {
    pendingIdleFinalizations.delete(sessionId)
    void finalizeSessionIdle(sessionId, traceId)
  }, SESSION_IDLE_FINALIZATION_WAIT_MS)
}

async function finalizeSessionIdle(sessionId: string, traceId: string) {
  if (!traceBatches.has(traceId)) return

  if (sessionId !== rootSessionId && isSubagentSession(sessionId)) {
    for (const g of allGenerations.filter(
      (gen) => gen.sessionId === sessionId && gen.traceId === traceId && !gen.finalOutput,
    )) {
      await finalizeGeneration(sessionId, g)
    }
    // The child session's own idle event is an authoritative boundary. Flush
    // any LLM that already has its final parts, finish reason, and usage now so
    // trace/session cleanup cannot cancel its short out-of-order settling timer.
    flushReadyGenerationObservationCompletions(traceId, sessionId)

    const agentSpanId = sessionToAgentSpan.get(sessionId)
    if (agentSpanId) {
      const existingAgentSpan = traceBatches.get(traceId)?.spans.find((span) => span.id === agentSpanId)
      const childGenerations = allGenerations.filter(
        (g) => g.parentObservationId === agentSpanId && g.traceId === traceId,
      )
      const lastChildGeneration = childGenerations[childGenerations.length - 1]
      const spanUpdates: Partial<SpanData> = {
        endTime: new Date().toISOString(),
        // Empty text is a valid final result (for example a tool-call-only
        // response). Do not replace it with the child prompt.
        output:
          lastChildGeneration?.finalOutput?.text ??
          sessionAssistantOutputs.get(sessionId) ??
          userInputs.get(sessionId) ??
          "",
        metadata: {
          ...(existingAgentSpan?.metadata ?? {}),
          childSessionId: sessionId,
        },
      }
      updateSpanInBatch(traceId, agentSpanId, spanUpdates)
      updateSpanImmediately(traceId, agentSpanId, spanUpdates)
      emitSpanObservationCompleted(traceId, agentSpanId, "session.idle")
      sessionToAgentSpan.delete(sessionId)
    }

    if (hasActiveSessionsForTrace(traceId)) {
      activeGenerations.delete(sessionId)
      pendingGenerations.delete(sessionId)
      sessionSpanIds.delete(sessionId)
      llmInputs.delete(sessionId)
      systemPrompts.delete(sessionId)
      userInputs.delete(sessionId)
      sessionAssistantOutputs.delete(sessionId)
      messageCounter.delete(sessionId)
      sessionToTrace.delete(sessionId)
      subagentParentBySession.delete(sessionId)
      idleSessionIds.delete(sessionId)
      trackedSessionIds.delete(sessionId)
      pendingSubagentSessions.delete(sessionId)
      return
    }
  }

  if (hasActiveSessionsForTrace(traceId)) return

  for (const g of allGenerations.filter((gen) => gen.traceId === traceId)) {
    if (!g.finalOutput) await finalizeGeneration(g.sessionId || sessionId, g)
  }
  // All sessions in this trace are idle now. Any generation that satisfies the
  // per-observation completeness predicate can be emitted synchronously before
  // cleanup clears its quiet-period timer.
  flushReadyGenerationObservationCompletions(traceId)

  const currentBatch = traceBatches.get(traceId)
  const traceOwnerSessionId = currentBatch?.sessionId || sessionId
  const finalText =
    getFinalTraceOutput(traceId, traceOwnerSessionId) ??
    (currentBatch ? getFinalTraceOutputFromBatch(currentBatch) : undefined)
  if (finalText !== undefined) {
    updateTraceBatch(traceId, { output: finalText })
    const batch = traceBatches.get(traceId)
    if (batch) upsertTraceImmediately(batch, true)
  }

  scheduleBackgroundIngestionDrain()

  const endedSessionIds = getSessionsForTrace(traceId)
  cleanupTraceState(traceId, endedSessionIds)
  refreshCurrentSessionPointers(traceId, endedSessionIds)
  if (traceBatches.size === 0) {
    skillCache.clear()
    allToolDefs.clear()
  }
}

// ==================== 插件主逻辑 ====================

export const LangfusePlugin: Plugin = async (ctx) => {
  currentPluginInstanceId = generateUUID()
  shutdownFlushPromise = null
  shutdownFlushCompleted = false
  const extendedCtx = ctx as unknown as ExtendedPluginInput
  pluginLog = extendedCtx.log
  pluginMetric = extendedCtx.metric
  startCompletedObservationStateMonitor()
  await deletePersistedFailedIngestionQueues()
  sessionParentResolver = async (sessionId) => {
    const result = await ctx.client.session.get({ path: { id: sessionId } })
    return result.data?.parentID
  }

  const user = User.get()
  // const user = {
  //   userId: "80295981",
  //   userName: "张丹",
  //   pathName: "总行/信息技术部/测试中心/测试技术团队/测试技术一室(成都)/测试技术二组",
  // }
  let project_id: string | null = null
  publicKey = "pk-lf-d89067e9-5eb3-42cc-b947-2d82a1a9e181"
  secretKey = "sk-lf-773528e2-aa24-48d0-9791-b7f795cbfb9a"
  if (user.userId && user.userName) {
    userIdMetadata = `${user.userName}/${user.userId}`
    const applyProjectApiKeys = (apiKeys: ProjectApiKeys, source: "cache" | "server") => {
      project_id = apiKeys.project_id
      publicKey = apiKeys.public_key
      secretKey = apiKeys.secret_key
      trackEvent("metric", {
        metricName: "plugin.langfuse.client.init.success",
        metricValue: 1,
        tags: {
          node: "pluginInitialization",
          action: "resolve_project_api_keys",
          status: "success",
          source,
          projectId: apiKeys.project_id,
          runtimeId: PLUGIN_RUNTIME_ID,
          pluginInstanceId: currentPluginInstanceId,
        },
      })
    }
    const refreshProjectApiKeys = async (allowCreateOnNotFound: boolean) => {
      const apiKeys = await get_project_apikeys(
        user.userId,
        user.userName,
        LANGFUSE_BASE_URL,
        user.pathName ?? null,
        { allowCreateOnNotFound },
      )
      if (apiKeys) {
        applyProjectApiKeys(apiKeys, "server")
        writeCachedProjectKeys(user.userId, user.userName, LANGFUSE_BASE_URL, apiKeys)
        return true
      }
      trackEvent("both", {
        level: "warn",
        message: "获取项目 API 密钥失败，将使用当前密钥",
        data: { userId: user.userId, userName: user.userName },
        metricName: "plugin.langfuse.api.error",
        metricValue: 1,
        tags: { api: "get_project_apikeys", reason: "missing_api_keys" },
      })
      return false
    }
    const cachedApiKeys = readCachedProjectKeys(user.userId, user.userName, LANGFUSE_BASE_URL)
    if (cachedApiKeys) {
      applyProjectApiKeys(cachedApiKeys, "cache")
    } else {
      try {
        await refreshProjectApiKeys(true)
      } catch (e) {
        trackEvent("both", {
          level: "error",
          message: "初始化动态密钥异常，将使用兜底密钥",
          data: { error: String(e), userId: user.userId },
          metricName: "plugin.langfuse.api.error",
          metricValue: 1,
          tags: { api: "get_project_apikeys" },
        })
      }
      if (!project_id) {
        trackEvent("both", {
          level: "warn",
          message: "未获取到项目 API 密钥，将使用兜底密钥",
          data: { userId: user.userId, userName: user.userName },
          metricName: "plugin.langfuse.api.error",
          metricValue: 1,
          tags: { api: "get_project_apikeys", reason: "fallback_keys" },
        })
      } else {
        trackEvent("metric", {
          metricName: "plugin.langfuse.api.success",
          metricValue: 1,
          tags: { api: "get_project_apikeys", status: "first_fetch", projectId: project_id },
        })
      }
    }
  } else {
    trackEvent("both", {
      level: "error",
      message: "获取用户信息失败，用户信息为空",
      data: { userId: user.userId, userName: user.userName },
      metricName: "plugin.langfuse.api.error",
      metricValue: 1,
      tags: { api: "get_user_info", reason: "missing_user_info" },
    })
  }


  baseMetadata = () => {
    const m: Record<string, string> = {}
    if (project_id) m.projectId = project_id
    if (userIdMetadata) m.user_id = userIdMetadata
    if (currentSessionId) m["sessionId"] = currentSessionId
    m.source = "testagent"
    return m
  }
  resetFailedIngestionQueue()
  scheduleBackgroundIngestionDrain()

  installProcessHandlers() // testagent_change

  return {
    /**
     * 处理聊天消息事件
     */
    "chat.message": async (input, output) => {
      const sessionId = getSessionId(input.sessionID)
      trackEvent("metric", {
        metricName: "plugin.langfuse.chat.message.received",
        metricValue: 1,
        tags: {
          node: "chatMessageHook",
          action: "receive",
          status: "received",
          runtimeId: PLUGIN_RUNTIME_ID,
          pluginInstanceId: currentPluginInstanceId,
          sessionId,
          messageId: input.messageID || "",
        },
      })
      trackedSessionIds.add(sessionId)
      idleSessionIds.delete(sessionId)

      if (!rootSessionId) {
        rootSessionId = sessionId
      }

      let traceId: string
      try {
        traceId = await getTraceIdAfterSessionCreated(sessionId, input.messageID)
      } catch (e) {
        trackEvent("both", {
          level: "error",
          message: "新对话解析 Trace ID 失败，未进入 Langfuse 上报队列",
          data: { error: String(e), sessionId, messageId: input.messageID },
          metricName: "plugin.langfuse.chat.trace.resolve.error",
          metricValue: 1,
          tags: {
            node: "chatMessageHook",
            action: "resolve_trace_id",
            status: "error",
            runtimeId: PLUGIN_RUNTIME_ID,
            pluginInstanceId: currentPluginInstanceId,
            sessionId,
          },
        })
        return
      }
      trackEvent("metric", {
        metricName: "plugin.langfuse.chat.trace.resolve.success",
        metricValue: 1,
        tags: {
          node: "chatMessageHook",
          action: "resolve_trace_id",
          status: "success",
          runtimeId: PLUGIN_RUNTIME_ID,
          pluginInstanceId: currentPluginInstanceId,
          sessionId,
          messageId: input.messageID || "",
          traceId,
        },
      })
      const textContent = output.parts
        .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
        .map((p: any) => p.text)
        .join("\n")
      userInputs.set(sessionId, textContent)
      const assistantOutput = extractTextFromParts(output.parts || [])
      const msg = output.message as { role?: string; info?: { role?: string } } | undefined // testagent_change
      const isAssistantMessage = msg?.role === "assistant" || msg?.info?.role === "assistant" // testagent_change
      if (isAssistantMessage && stripThinkTags(assistantOutput)) {
        sessionAssistantOutputs.set(sessionId, assistantOutput)
      }

      const count = (messageCounter.get(sessionId) || 0) + 1
      messageCounter.set(sessionId, count)

      const batch = createTraceBatch(sessionId, textContent || "message", ctx, traceId)
      if (isAssistantMessage) {
        const finalText = stripThinkTags(assistantOutput)
        if (finalText) batch.output = finalText
      }
      updateTraceBatch(traceId, {
        ...(isAssistantMessage && stripThinkTags(assistantOutput)
          ? { output: stripThinkTags(assistantOutput) }
          : {}),
        metadata: {
          ...batch.metadata,
          messageID: input.messageID,
          messageIndex: count,
          isSubagent: isSubagentSession(sessionId),
          input: {
            sessionID: input.sessionID,
            agent: input.agent,
            model: input.model,
            messageID: input.messageID,
            variant: input.variant,
          },
        },
      })
      upsertTraceImmediately(batch)
    },

    /**
     * 缓存最终发给 LLM 的上下文消息
     */
    "experimental.chat.messages.transform": async (_, output) => {
      await captureToolResultsFromMessages(output.messages)

      const bySession = new Map<string, typeof output.messages>()

      for (const message of output.messages) {
        const sessionId = message.info?.sessionID || currentSessionId
        if (!sessionId) continue

        const existing = bySession.get(sessionId) ?? []
        existing.push(message)
        bySession.set(sessionId, existing)
      }

      if (bySession.size === 0 && currentSessionId) {
        llmInputs.set(currentSessionId, output.messages)
        return
      }

      for (const [sessionId, messages] of bySession) {
        llmInputs.set(sessionId, messages)
      }
    },

    "command.execute.before": async (input, output) => {
      if (input.source !== "skill") return
      commandBeforeData.set(input.sessionID, {
        name: input.command,
        source: input.source,
        id: input.id,
        version: input.version,
      })
    },

    /**
     * 处理聊天参数事件，创建 LLM generation
     */
    "chat.params": async (input, output) => {
      const sessionId = getSessionId(input.sessionID)
      trackEvent("metric", {
        metricName: "plugin.langfuse.opencode.chat.params.received",
        metricValue: 1,
        tags: {
          node: "opencodeChatParamsHook",
          action: "receive",
          status: "received",
          runtimeId: PLUGIN_RUNTIME_ID,
          pluginInstanceId: currentPluginInstanceId,
          sessionId,
          providerId: input.model?.providerID || "unknown",
          modelId: input.model?.id || "unknown",
        },
      })
      // Snapshot ownership before any await. Session association can pause this
      // handler while a later skill changes the active context.
      const parentObservationId = getSessionObservationParent(sessionId)
      const isSkillChild = !!getCurrentSkillContext(sessionId, sessionToTrace.get(sessionId) || currentTraceId)
      const pendingSequence = ++pendingGenerationSequence
      const traceId = await getTraceIdAfterSessionCreated(sessionId)
      const childSubagentType = getSessionSubagentType(sessionId, traceId)

      const providerId = input.model?.providerID || "unknown"
      const modelId = input.model?.id || "unknown"
      const modelName = `${providerId}/${modelId}`
      const selectedModel = selectedModelsBySession.get(sessionId) || normalizeModelSelection(input.model)
      const resolvedModel = modelName
      const apiId = input.model?.apiId || "unknown"
      const messages = llmInputs.get(sessionId) || []
      const system = systemPrompts.get(sessionId) || []
      // testagent_change - use tools after agent/user permission filtering
      const tools = activeToolDefs(input.activeTools)
      const builtInput = buildLLMInput(messages, system, tools)
      const llmInput = builtInput.json
      const llmInputDict = builtInput.dict
      await captureToolResultsFromLLMInputMessages((llmInputDict as any).messages || [], sessionId, traceId)

      // This is only a pending placeholder. activatePendingGeneration replaces
      // it with the first concrete message-part timestamp before ingestion.
      const startTime = new Date()
      const genId = generateUUID()

      const modelParameters: Record<string, any> = {}
      if (output.temperature !== undefined) modelParameters.temperature = output.temperature
      if (output.topP !== undefined) modelParameters.top_p = output.topP
      if (output.topK !== undefined) modelParameters.top_k = output.topK
      if (output.maxOutputTokens !== undefined) modelParameters.max_tokens = output.maxOutputTokens

      const commandMeta = commandBeforeData.get(sessionId)
      if (commandMeta) commandBeforeData.delete(sessionId)

      const genMetadata = {
        spanKind: "LLM",
        model: buildLLMModelMetadata({
          modelName,
          modelParameters,
          apiId,
          selectedModel,
          resolvedModel,
        }),
        output: {},
        tags: OBSERVATION_TAGS,
        ...(childSubagentType ? { subagent_type: childSubagentType } : {}),
        ...(commandMeta ? {commandData: commandMeta} : {}),
        ...baseMetadata(),
      }

      // Keep the request pending until a message part confirms that this LLM
      // call actually started. chat.params itself has no assistant message ID.
      const genData: GenerationData = {
        id: genId,
        traceId,
        parentObservationId,
        name: "LLM",
        model: modelName,
        modelParameters,
        input: llmInput,
        startTime: startTime.toISOString(),
        metadata: genMetadata,
        tags: OBSERVATION_TAGS,
      }

      const genInfo: GenInfo = {
        traceId,
        genId,
        sessionId,
        parentObservationId,
        selectedModel,
        resolvedModel,
        modelName,
        apiId,
        startTime,
        completionStartTime: null,
        responseEndTime: null,
        stepNumber: (gens.get(traceId)?.length || 0) + (pendingGenerations.get(sessionId)?.length || 0) + 1,
        output: "",
        parts: [],
        textPartSnapshots: new Map(),
        textPartSequence: 0,
        toolCalls: [],
        isSkillChild,
        hasUsage: false,
        finalOutput: null,
        modelParameters,
        input: llmInputDict,
        generationData: genData,
        pendingSequence,
      }

      const pending = pendingGenerations.get(sessionId) ?? []
      const insertionIndex = pending.findIndex((entry) => entry.pendingSequence > genInfo.pendingSequence)
      if (insertionIndex === -1) pending.push(genInfo)
      else pending.splice(insertionIndex, 0, genInfo)
      pendingGenerations.set(sessionId, pending)
    },

    /**
     * 转换系统消息
     */
    "experimental.chat.system.transform": async (input, output) => {
      const sessionId = input.sessionID || currentSessionId || [...trackedSessionIds].pop()
      if (sessionId && output.system && output.system.length > 0) {
        systemPrompts.set(sessionId, output.system)
      }
    },

    /**
     * 工具定义修改
     */
    "tool.definition": async (input, output) => {
      allToolDefs.set(input.toolID, {
        id: input.toolID,
        description: output.description,
        parameters: output.parameters,
      })
    },

    /**
     * 工具执行前事件
     */
    "tool.execute.before": async (input, output) => {
      // transformWriteArgs(input.tool, output.args)

      // Keep the start boundary stable if this handler later waits for session
      // association. The hook payload timestamp remains preferred when present.
      const toolObservedAt = new Date()
      const reportedToolStartTime =
        getPartTimestamp(output, "start") ?? getPartTimestamp(input, "start")

      const sessionId = input.sessionID || currentSessionId || [...trackedSessionIds].pop()
      if (!sessionId) return

      // Activate the LLM that issued this tool call before changing skill
      // ownership. Otherwise a still-pending caller generation could be
      // incorrectly attached to the skill it is about to invoke.
      const toolStartTime = reportedToolStartTime ?? toolObservedAt
      const precedingGeneration =
        getLatestActiveGeneration(sessionId) ?? activatePendingGeneration(sessionId, undefined, { startTime: toolStartTime })
      if (precedingGeneration) markGenerationResponseFinished(precedingGeneration, toolStartTime)

      const isSkill = input.tool === "skill"
      const skillSpanId = isSkill ? generateUUID() : undefined
      // A new skill starts a new grouping root for this session. Clear the
      // previous skill before taking its parent snapshot, so sequential skills
      // are siblings (or children of the subagent), not nested under each other.
      const knownTraceId = sessionToTrace.get(sessionId) || currentTraceId
      if (isSkill) {
        activeSkillContexts.delete(sessionId)
        if (knownTraceId) activeSkillSpanByTrace.delete(knownTraceId)
      }

      // Preserve the caller's ownership before session resolution yields. The
      // trace-wide state may advance to a later skill while this hook waits.
      const toolParentObservationId = getSessionObservationParent(sessionId)
      const agentParentObservationId = toolParentObservationId
      if (isSkill && skillSpanId) {
        const provisionalTraceId = sessionToTrace.get(sessionId) || currentTraceId || getTraceIdForSession(sessionId)
        activeSkillSpanByTrace.set(provisionalTraceId, skillSpanId)
        activeSkillContexts.set(sessionId, {
          callID: input.callID,
          context: {
            spanId: skillSpanId,
            traceId: provisionalTraceId,
            gens: [],
            parentSpanId: toolParentObservationId,
            isSubagent: true,
          },
        })
      }
      const traceId = await getTraceIdAfterSessionCreated(sessionId)
      const childSubagentType = getSessionSubagentType(sessionId, traceId)
      const startTime = toolStartTime

      const isTask = input.tool === "task"
      // OpenCode has exposed the target agent on both input and transformed
      // args across versions. A task always launches a child session, so keep
      // a stable fallback rather than skipping its trace association.
      const subagentType =
        output.args?.subagent_type ||
        input.args?.subagent_type ||
        output.args?.agent ||
        input.args?.agent ||
        (input.tool === "task" ? "subagent" : undefined)
      if (!traceBatches.has(traceId)) {
        const batch = createTraceBatch(sessionId, userInputs.get(sessionId) || "tool execution", ctx, traceId)
        upsertTraceImmediately(batch)
      }

      const spanId = skillSpanId ?? generateUUID()
      const skillName = output.args?.name || output.args?.skill || "skill"
      const spanName = isSkill ? `skill:${skillName}` : `tool:${input.tool}`

      const spanData: SpanData = {
        id: spanId,
        traceId,
        parentObservationId: toolParentObservationId,
        name: spanName,
        input: sanitize(output.args),
        startTime: startTime.toISOString(),
        metadata: {
          spanKind: "TOOL",
          nodeType: isSkill ? "skill" : "tool",
          tags: OBSERVATION_TAGS,
          ...(childSubagentType ? { subagent_type: childSubagentType } : {}),
          input: {
            tool: input.tool,
            args: output.args,
          },
          ...baseMetadata(),
        },
        tags: OBSERVATION_TAGS,
      }

      if (isSkill) {
        appendTraceSkillInfo(traceId, { skillName, skillSpanId: spanId })
        // Keep this skill as the parent of every following LLM/tool node until
        // the next skill starts. The next skill clears this slot above first,
        // which makes sibling skill spans pop back to the same parent level.
        activeSkillSpanByTrace.set(traceId, spanId)
        pendingSkillSpans.set(input.callID, spanData)
        // The skill span must exist before any LLM/tool node that follows it.
        // Keep the existing skillInfo snapshot timing, but do not defer its
        // span-create event until tool.execute.after.
        addSpanToBatch(traceId, spanData)
        createSpanImmediately(spanData)
      } else {
        addSpanToBatch(traceId, spanData)
        createSpanImmediately(spanData)
      }
      toolSpanIds.set(input.callID, spanId)
      toolCallInfos.set(input.callID, { spanId, traceId, sessionId, toolName: input.tool })
      recordSessionSpan(sessionId, spanId)

      let agentSpanId: string | undefined
      if (isTask && subagentType) {
        agentSpanId = generateUUID()
        const agentStartTime = new Date()

        const agentSpanData: SpanData = {
          id: agentSpanId,
          traceId,
          parentObservationId: agentParentObservationId,
          name: `agent:${subagentType}`,
          input: { prompt: output.args.prompt, description: output.args.description },
          startTime: agentStartTime.toISOString(),
          metadata: {
            spanKind: "AGENT",
            nodeType: "subagent",
            subagent_type: subagentType,
            description: output.args.description,
            tags: OBSERVATION_TAGS,
            trigger: {
              tool: input.tool,
              callID: input.callID,
              toolSpanId: spanId,
            },
            ...baseMetadata(),
          },
          tags: OBSERVATION_TAGS,
        }

        addSpanToBatch(traceId, agentSpanData)
        createSpanImmediately(agentSpanData)
        recordSessionSpan(sessionId, agentSpanId)
        await queuePendingSubagent(sessionId, { traceId, agentSpanId })

        // console.log("[langfuse] subagent call detected:", subagentType, "toolSpanId:", spanId, "agentSpanId:", agentSpanId)
      }

      if (isSkill) {
        const skillContext: SkillContext = {
          spanId,
          traceId,
          gens: [],
          parentSpanId: toolParentObservationId,
          isSubagent: true, // 标记为 subagent
        }
        // A later skill can begin while this handler is awaiting session
        // association. Do not let the older handler take ownership back.
        if (activeSkillContexts.get(sessionId)?.callID === input.callID) {
          activeSkillContexts.set(sessionId, { callID: input.callID, context: skillContext })
        }
      }
    },

    /**
     * 工具执行后事件
     */
    "tool.execute.after": async (input, output) => {
      // write/edit/bash 后：直接覆写磁盘文件，把 TESTCASE_ID 替换为 TCuuid
      let fileContent: string | undefined
      let autoTestContent: string | undefined
      let autoTestFilePath: string | undefined
      if ((input.tool === "write" || input.tool === "edit")) {
        if (isBaseFile(input.args?.filePath)) {
        const filePath: string = input.args.filePath
        try {
          const raw = readFileSync(filePath, "utf-8")
          if (raw.includes("TESTCASE_ID")) {
            const injectedContent = injectTestcaseIds(raw)
            fileContent = injectedContent
            writeFileSync(filePath, injectedContent, "utf-8")
          } else {
            // 检查是否有任何 testcase_id 符合 testagent 模式
            // 正则匹配: TC + 2个字符 + t + 3个字符 + e + 2个字符 + s + 3个字符 + t + 2个字符 + a + 3个字符 + g + 2个字符 + e + 3个字符 + n + 2个字符 + t + 1个字符
            const testagentPattern = /testcase_id:\s*(TC[a-f0-9]{2}t[a-f0-9]{3}e[a-f0-9]{2}s[a-f0-9]{3}t[a-f0-9]{2}a[a-f0-9]{3}g[a-f0-9]{2}e[a-f0-9]{3}n[a-f0-9]{2}t[a-f0-9])/gi
            const hasTestagentId = testagentPattern.test(raw)
            
            if (hasTestagentId) {
              // 替换所有不符合 testagent 模式的 testcase_id
              const updatedContent = replaceNonTestagentTestcaseIds(raw)
              if (updatedContent !== raw) {
                fileContent = updatedContent
                writeFileSync(filePath, updatedContent, "utf-8")
              }
            }
          }
        } catch (e) {
          // 文件读写失败时静默忽略，不影响正常流程
        }
        } else if (isAutoTestPyFile(input.args?.filePath)) {
          // 自动化测试目录下的 Python 文件：直接读取文件内容
          const filePath: string = input.args.filePath
          try {
            autoTestFilePath = resolve(filePath)
            autoTestContent = readFileSync(filePath, "utf-8")
          } catch (e) {
            // 文件读写失败时静默忽略，不影响正常流程
          }
        }
      }
      if (input.tool === "bash" && typeof input.args?.command === "string") {
        if (BASH_FILE_RE.test(input.args.command)) {
        const match = input.args.command.match(/["']([^"']*测试案例[/\\][^"']+\.(yaml|yml))["']/)
        if (match) {
          const filePath = match[1]
          try {
            const raw = readFileSync(filePath, "utf-8")
            if (raw.includes("TESTCASE_ID")) {
              const injectedContent = injectTestcaseIds(raw)
              fileContent = injectedContent
              writeFileSync(filePath, injectedContent, "utf-8")
            } else {
              // 检查是否有任何 testcase_id 符合 testagent 模式
              // 正则匹配: TC + 2个字符 + t + 3个字符 + e + 2个字符 + s + 3个字符 + t + 2个字符 + a + 3个字符 + g + 2个字符 + e + 3个字符 + n + 2个字符 + t + 1个字符
              const testagentPattern = /testcase_id:\s*(TC[a-f0-9]{2}t[a-f0-9]{3}e[a-f0-9]{2}s[a-f0-9]{3}t[a-f0-9]{2}a[a-f0-9]{3}g[a-f0-9]{2}e[a-f0-9]{3}n[a-f0-9]{2}t[a-f0-9])/gi
              const hasTestagentId = testagentPattern.test(raw)
              
              if (hasTestagentId) {
                // 替换所有不符合 testagent 模式的 testcase_id
                const updatedContent = replaceNonTestagentTestcaseIds(raw)
                if (updatedContent !== raw) {
                  fileContent = updatedContent
                  writeFileSync(filePath, updatedContent, "utf-8")
                }
              }
            }
          } catch (e) {
            // 文件读写失败时静默忽略
            }
          }
        } else if (/自动化测试[/\\].+\.py['"]/.test(input.args.command)) {
          // 检查 bash 命令中是否包含自动化测试目录下的 Python 文件
          const pyMatch = input.args.command.match(/["']([^"']*自动化测试[/\\][^"']+\.py)["']/)
          if (pyMatch) {
            const filePath = pyMatch[1]
            try {
              autoTestFilePath = resolve(filePath)
              autoTestContent = readFileSync(filePath, "utf-8")
            } catch (e) {
              // 文件读写失败时静默忽略
            }
          }
        }
      }

      const callInfo = toolCallInfos.get(input.callID)
      const spanId = callInfo?.spanId ?? toolSpanIds.get(input.callID)
      if (!spanId) return

      const traceId = callInfo?.traceId || sessionToTrace.get(input.sessionID) || currentTraceId
      if (!traceId) return

      const isSkill = input.tool === "skill"
      const isSkillRead =
        input.tool === "read" &&
        typeof input.args?.filePath === "string" &&
        /(^|[/\\])SKILL\.md$/i.test(input.args.filePath)

      // 如果是 skill 工具，读取原始 SKILL.md
      let skillYamlInfo: Record<string, any> | undefined
      let skillFilePath: string | null = null
      if (isSkill && output.metadata?.dir) {
        skillFilePath = resolveSkillFilePath(output.metadata.dir)
      } else if (isSkillRead) {
        skillFilePath = input.args.filePath
      }

      if (skillFilePath) {
        const info = loadSkillRaw(skillFilePath)
        if (info) {
          skillYamlInfo = info.yaml
        }
      }

      let skillName = input.args?.name || input.args?.skill || "skill"
      let skillDesc = ""
      let skillId = input.args?.id || input.args?.skillId || input.args?.skill_id
      if (skillYamlInfo) {
        skillDesc = skillYamlInfo.description
        skillId = skillYamlInfo.id || skillId
      }
      const toolDef = allToolDefs.get(input.tool)
      const cachedResult = toolResultSnapshots.get(input.callID)
      const endTime =
        getPartTimestamp(output, "end") ?? getPartTimestamp(input, "end") ?? cachedResult?.completedAt ?? new Date()
      const effectiveOutput =
        (output.output === null || output.output === undefined) && cachedResult?.output != null
          ? cachedResult.output
          : output.output
      const effectiveTitle = output.title ?? cachedResult?.title
      const effectiveMetadata = output.metadata ?? cachedResult?.metadata

      const existingSpan = traceBatches.get(traceId)?.spans.find((span) => span.id === spanId)
      const toolPartCompleted = cachedResult?.toolPartCompleted === true || existingSpan?.metadata?.toolPartCompleted === true
      const toolStatus = cachedResult?.toolStatus ?? existingSpan?.metadata?.toolStatus
      const toolCompletionSource = isSkill
        ? "tool.execute.after"
        : cachedResult?.toolCompletionSource ??
          existingSpan?.metadata?.toolCompletionSource ??
          "tool.execute.after"
      const spanOutput = toSpanOutput(effectiveOutput)

      const spanUpdates: Partial<SpanData> = {
        ...(spanOutput !== undefined ? { output: spanOutput } : {}),
        // The tool result may already have completed through message.part.updated.
        // tool.execute.after can arrive later, so it may enrich the span but must
        // not move its end time forward.
        endTime: existingSpan?.endTime ?? endTime.toISOString(),
        level: effectiveOutput === null ? "ERROR" : "DEFAULT",
        metadata: {
          ...(existingSpan?.metadata || {}),
          spanKind: "TOOL",
          nodeType: isSkill ? "skill" : "tool",
          toolAfterReceived: true,
          toolPartCompleted,
          toolCompletionSource,
          ...(toolStatus ? { toolStatus } : {}),
          tags: OBSERVATION_TAGS,
          output: {
            title: effectiveTitle,
            output: effectiveOutput,
            metadata: effectiveMetadata,
            ...(skillYamlInfo && { yaml: skillYamlInfo }),
          },
          input: {
            name: isSkill ? skillName : input.tool,
            args: input.args,
            description: isSkill ? skillDesc : toolDef?.description,
            input_schema: isSkill
              ? {}
              : toolDef
                ? {
                    parameters: toJsonSchema(toolDef.parameters || { type: "object", properties: {} }),
                  }
                : undefined,
          },
          ...(fileContent && { fileContent }),
          ...(autoTestContent && { autoTestContent }),
          ...(autoTestFilePath && { autoTestFilePath }),
          ...baseMetadata(),
        },
      }

      if (isSkill) {
        updateTraceSkillInfo(traceId, spanId, { skillId })
        const finalSpanUpdates: Partial<SpanData> = {
          name: `skill:${skillName}`,
          ...spanUpdates,
        }
        updateSpanInBatch(traceId, spanId, finalSpanUpdates)
        updateSpanImmediately(traceId, spanId, finalSpanUpdates)
        tryCompleteToolObservation(traceId, spanId)
        pendingSkillSpans.delete(input.callID)
        toolSpanIds.delete(input.callID)
        toolCallInfos.delete(input.callID)
        toolResultSnapshots.delete(input.callID)
      } else {
        updateSpanInBatch(traceId, spanId, spanUpdates)
        updateSpanImmediately(traceId, spanId, spanUpdates)
        tryCompleteToolObservation(traceId, spanId)
      }

      if (!isSkill && effectiveOutput !== null && effectiveOutput !== undefined && toolPartCompleted) {
        toolSpanIds.delete(input.callID)
        toolCallInfos.delete(input.callID)
        toolResultSnapshots.delete(input.callID)
      }
    },

    /**
     * 文本补全事件
     */
    "experimental.text.complete": async (input, output) => {
      const sessionId = input.sessionID || currentSessionId
      if (!sessionId) return

      // Some providers only emit this completion callback, without a streamed
      // message part. It proves the request ran, so activate the pending
      // generation; its terminal handler will write the canonical structured
      // output (text, tool_calls, usage, and finish_reason).
      // text.complete has the concrete assistant message ID. Do not use the
      // newest active generation here: a late step-finish from a preceding
      // tool-call step can leave two generations active briefly, causing this
      // response text to be written onto the wrong LLM node while the current
      // node still receives its own usage from step-finish.
      const partId = getTextPartId(input)
      const g = getOrActivateGenerationForPart(sessionId, {
        type: "text",
        messageID: input.messageID,
        partID: partId,
      }, getPartTimestamp(output, "start") ?? getPartTimestamp(input, "start"), {
        // This hook is emitted synchronously by the active provider call. A
        // repeated assistant message ID must not make it look like a stale bus
        // part and suppress the only authoritative final text.
        allowCompletedMessageReuse: true,
      })
      if (!g) return

      const completedText = typeof output.text === "string" ? output.text : ""
      if (partId) {
        updateGenerationTextPart(g, partId, "text", completedText, { complete: true })
        syncCompletedVisibleText(g)
      } else {
        // Compatibility fallback for older plugin APIs without partID.
        g.output = completedText
      }
      markGenerationResponseFinished(
        g,
        getPartTimestamp(output, "end") ?? getPartTimestamp(input, "end") ?? new Date(),
      )

      // Preserve Langfuse's output contract even during the short interval
      // before a late step-finish supplies provider usage and finish reason.
      const partialOutput = {
        text: buildGenerationText(g),
        tool_calls: g.toolCalls.map((tc) => ({
          type: "function",
          function: { name: tc.name, arguments: tc.args || {} },
        })),
        usage: toOutputUsage({ input: 0, output: 0, total: 0 }),
        finish_reason: "unknown",
      }

      const generationUpdates: Partial<GenerationData> = {
        output: JSON.stringify(partialOutput, null, 2),
        metadata: {
          spanKind: "LLM",
          model: buildLLMModelMetadata(g),
          output: partialOutput,
          tags: OBSERVATION_TAGS,
          ...baseMetadata(),
        },
      }

      updateGenerationInBatch(g.traceId, g.genId, generationUpdates)
      updateGenerationImmediately(g.traceId, g.genId, generationUpdates)
      scheduleGenerationObservationCompletion(g)
    },

    /**
     * 通用事件处理器
     */
    event: async (input: any) => {
      const evt = input?.event
      if (!evt) return

      // 服务器实例销毁时，刷新所有数据
      if (evt.type === "server.instance.disposed") {
        stopCompletedObservationStateMonitor()
        await flushAllTracesOnce()
        clearAllCompletedObservationState()
        return
      }

      // 会话创建时，建立主从session关系
      if (evt.type === "session.created") {
        const sessionInfo = evt.properties?.info || evt.properties?.session || evt.properties || {}
        const sid = sessionInfo.id || evt.sessionID || evt.properties?.sessionID
        const parentId =
          sessionInfo.parentID ||
          sessionInfo.parentId ||
          evt.properties?.parentID ||
          evt.properties?.parentId
        if (sid) {
          trackEvent("metric", {
            metricName: "plugin.langfuse.opencode.session.created.received",
            metricValue: 1,
            tags: {
              node: "opencodeEventHook",
              action: "receive_session_created",
              status: "received",
              runtimeId: PLUGIN_RUNTIME_ID,
              pluginInstanceId: currentPluginInstanceId,
              sessionId: sid,
              parentSessionId: parentId || "",
            },
          })
          trackedSessionIds.add(sid)
          idleSessionIds.delete(sid)
          // If events begin with a child, wait for its parent instead of
          // permanently treating the child as the trace root.
          if (!rootSessionId && !parentId) {
            rootSessionId = sid
          }

          if (parentId) {
            await associateSubagentSession(sid, parentId)
            // console.log("[langfuse] subagent session created:", sid, "parent:", parentId, "using trace:", inheritedTraceId)
          }
          // Wake child hooks only after the trace/agent parent association is
          // installed. Otherwise their first chat event can race ahead and
          // allocate a fallback trace for the newly-created subagent session.
          markSessionCreated(sid)
        }
      }

      if (evt.type === "message.part.updated" && evt.properties?.part) {
        const part = evt.properties.part
        const sessionId = part.sessionID || currentSessionId
        if (!sessionId) return
        trackEvent("metric", {
          metricName: "plugin.langfuse.opencode.message.part.updated.received",
          metricValue: 1,
          tags: {
            node: "opencodeEventHook",
            action: "receive_message_part_updated",
            status: "received",
            runtimeId: PLUGIN_RUNTIME_ID,
            pluginInstanceId: currentPluginInstanceId,
            sessionId,
            traceId: sessionToTrace.get(sessionId) || "",
            partType: part.type || "unknown",
            partStatus: part.state?.status || "",
            messageId: part.messageID || "",
          },
        })

        if (part.type === "tool" && part.callID && part.state?.status === "completed" && hasOwn(part.state, "output")) {
          const snapshot = {
            output: part.state.output,
            metadata: part.metadata,
            title: part.title,
            completedAt: getToolPartCompletedAt(part, evt.properties?.time),
            toolStatus: "completed",
            toolPartCompleted: true,
            toolCompletionSource: "message.part.updated",
          }
          toolResultSnapshots.set(part.callID, snapshot)

          await updateToolSpanOutputFromSnapshot(
            part.callID,
            sessionToTrace.get(sessionId) || currentTraceId,
            snapshot.completedAt,
            snapshot,
          )
        }

        const g = getOrActivateGenerationForPart(sessionId, part, evt.properties?.time)

        if (g && part.type !== "step-finish") {
          if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
            if (part.text) {
              markGenerationCompletionStarted(g, getEventTimestamp(evt.properties?.time) ?? new Date())
            }
            const partId = getTextPartId(part) ?? `${part.messageID || g.genId}:${part.type}`
            updateGenerationTextPart(g, partId, part.type, part.text, {
              complete: !!getPartTimestamp(part, "end"),
            })
            if (part.type === "text" && getPartTimestamp(part, "end")) {
              syncCompletedVisibleText(g)
            }
            refreshFinalizedGenerationText(g)
            scheduleGenerationObservationCompletion(g)
          }
          if (part.type === "tool" && part.state?.status === "running") {
            markGenerationCompletionStarted(g, getEventTimestamp(evt.properties?.time) ?? new Date())
            const toolName = part.tool
            const toolArgs = part.state?.input ?? {}
            const toolStr = `Tool Call: ${toolName}(${JSON.stringify(toolArgs)?.substring(0, 500)})`
            if (!g.parts.some((p) => p.startsWith(`Tool Call: ${toolName}(`))) {
              g.parts.push(toolStr)
            }
            if (!g.toolCalls.some((tc) => tc.toolCallId === (part.callID || ""))) {
              g.toolCalls.push({
                toolCallId: part.callID || "",
                name: toolName,
                args: toolArgs,
              })
            }
          }
          if (part.type === "tool" && part.state?.status === "completed" && hasOwn(part.state, "output")) {
            const resultText = part.state.output === undefined ? "" : stringifyToolOutput(part.state.output)
            if (!g.toolResults) g.toolResults = []
            const toolCallId = part.callID || ""
            const existingToolResult = g.toolResults.find((tr) => tr.toolCallId === toolCallId && toolCallId)
            const toolResult = {
              toolCallId: part.callID || "",
              name: part.tool || "",
              output: resultText,
              metadata: part.metadata,
              index: g.toolCalls.findIndex((tc) => tc.toolCallId === (part.callID || "")),
              args: g.toolCalls.find((tc) => tc.toolCallId === (part.callID || ""))?.args || {},
            }
            if (existingToolResult) {
              Object.assign(existingToolResult, toolResult)
            } else {
              g.parts.push(`Tool Result: ${resultText.substring(0, 1000)}`)
              g.toolResults.push(toolResult)
            }
          }
        }

        if (part.type === "step-finish" && g) {
          await finalizeGeneration(sessionId, g, {
            tokens: part.tokens,
            endTime: getPartTimestamp(part, "end") ?? getEventTimestamp(evt.properties?.time) ?? g.responseEndTime ?? new Date(),
            finishReason: part.reason,
          })
        }
      }

      if (evt.type === "message.part.delta") {
        const properties = evt.properties ?? {}
        const sessionId = properties.sessionID || currentSessionId
        const partId = properties.partID
        const delta = properties.delta
        if (!sessionId || typeof partId !== "string" || properties.field !== "text" || typeof delta !== "string") {
          return
        }

        const g =
          findGenerationForTextPart(sessionId, partId) ??
          getOrActivateGenerationForPart(
            sessionId,
            {
              // The delta event does not identify text vs reasoning. The
              // initial/final part snapshot will reconcile the actual type.
              type: "text",
              messageID: properties.messageID,
              partID: partId,
            },
            properties.time,
          )
        if (!g) return

        markGenerationCompletionStarted(g, getEventTimestamp(properties.time) ?? new Date())
        updateGenerationTextPart(g, partId, "unknown", delta, { delta: true })
        refreshFinalizedGenerationText(g)
        scheduleGenerationObservationCompletion(g)
      }

      if (evt.type === "session.idle") {
        const idleSessionId = evt.sessionID ?? evt.properties?.sessionID
        const sessionId = idleSessionId
        if (!sessionId) return

        // Ignore a duplicate idle event from a child session that was already
        // detached after it completed; falling back to currentTraceId here could
        // otherwise finalize an unrelated concurrent trace.
        if (!sessionToTrace.has(sessionId) && !trackedSessionIds.has(sessionId)) return

        const traceId =
          sessionToTrace.get(sessionId) ||
          currentTraceId ||
          (rootSessionId ? sessionToTrace.get(rootSessionId) : undefined)
        if (!traceId) return

        idleSessionIds.add(sessionId)
        // Do not await here: plugin events can be dispatched serially, in which
        // case awaiting would prevent the queued step-finish event from running.
        scheduleSessionIdleFinalization(sessionId, traceId)
        return
      }

      if (evt.type === "session.error") {
        const sessionId = evt.sessionID || currentSessionId
        if (sessionId) {
          const traceId = sessionToTrace.get(sessionId) || currentTraceId
          if (traceId) {
            // An error can occur before any message part is emitted. Record the
            // in-flight call as an errored generation instead of leaving a
            // pending candidate to be silently discarded at trace cleanup.
            const erroredGeneration =
              getLatestActiveGeneration(sessionId) ??
              activatePendingGeneration(sessionId, undefined, { preferLatest: true })
            if (erroredGeneration && !erroredGeneration.finalOutput) {
              await finalizeGeneration(sessionId, erroredGeneration, { finishReason: "error" })
            }

            updateTraceBatch(traceId, {
              metadata: {
                ...traceBatches.get(traceId)?.metadata,
                error: evt.error?.message,
              },
            })
            const batch = traceBatches.get(traceId)
            if (batch) {
              upsertTraceImmediately(batch)
            }
            scheduleBackgroundIngestionDrain()
          }
        }
      }
    },
  }
}

export default LangfusePlugin
