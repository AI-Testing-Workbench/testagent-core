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
import { dirname, join, resolve } from "path"
import { homedir } from "os"

// const LANGFUSE_BASE_URL = "https://testhub-agent-trace-dev.paas.cmbchina.cn";

const LANGFUSE_BASE_URL = decodeURIComponent(
  atob("aHR0cCUzQSUyRiUyRnRlc3RodWItYWdlbnQtdHJhY2UucGFhc3VhdC5jbWJjaGluYS5jbg=="),
)
const ENABLE_FINAL_BATCH_UPLOAD = false
const LANGFUSE_FINAL_BATCH_UPLOAD_PATH = "/api/trpc/batchTrace.save"
const VERSION = "1.0.2"
const LANGFUSE_FETCH_TIMEOUT_MS = 5000
const LANGFUSE_FINAL_BATCH_UPLOAD_TIMEOUT_MS = 30000
const LANGFUSE_KEY_LOOKUP_TIMEOUT_MS = 15000
const TESTAGENT_DATA_DIR = join(homedir(), ".local", "share", "testagent")
const LANGFUSE_KEY_CACHE_FILE = join(TESTAGENT_DATA_DIR, "langfuse-project-keys.json")
const MAX_INGESTION_BATCH_BYTES = 1024 * 1024
const MAX_OBSERVED_TEXT_LENGTH = 10000

let baseMetadata: () => Record<string, string>

// ==================== 会话管理 ====================

let currentSessionId: string | null = null
let rootSessionId: string | null = null // 主session ID
const sessionToTrace = new Map<string, string>() // sessionId -> traceId
const sessionToAgentSpan = new Map<string, string>() // subagent session -> agent span id
const pendingSubagents = new Map<string, { traceId: string; agentSpanId: string }[]>() // parent session -> pending subagents
const generatedTraceIds = new Set<string>() // trace ids generated as fallback before opencode messageID is available

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
  stepNumber: number
  output: string
  parts: string[]
  toolCalls: Array<{ toolCallId: string; name: string; args: any }>
  toolResults?: Array<{ toolCallId: string; name: string; output: string; index: number; args: any; metadata?: any }>
  isSkillChild: boolean
  hasUsage: boolean
  finalOutput: { text: string; tool_calls?: any[]; usage?: any } | null
  assistantMessageId?: string
  modelParameters: Record<string, any>
  input: any
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

// ==================== 全局状态管理 ====================

// 批量上传数据存储: traceId -> TraceBatch
const traceBatches = new Map<string, TraceBatch>()

// 存储每个 trace 的 generation 列表
const gens = new Map<string, GenInfo[]>()

// 存储工具调用的 Span ID
const toolSpanIds = new Map<string, string>()
const toolCallInfos = new Map<string, { spanId: string; traceId: string; sessionId: string; toolName?: string }>()
const sessionSpanIds = new Map<string, Set<string>>()

// 工具结果有时先出现在 message.part.updated，随后 tool.execute.after 的 output 仍为 null。
// 按 callID 缓存已完成结果，用来回填同一个 TOOL span。
const toolResultSnapshots = new Map<string, { output: any; metadata?: any; title?: string }>()

// LIFO 栈，维护嵌套 skill 调用链
const skillStack: { callID: string; context: SkillContext }[] = []

// 全局 generation 列表
const allGenerations: GenInfo[] = []

// 当前活跃的 generation 队列（按 session 维护，避免主/子 agent 相互覆盖，也避免多 step 事件交错互相覆盖）
const activeGenerations = new Map<string, GenInfo[]>()

// 记录用户在消息阶段选择的模型，避免网关降级后丢失原始选择
const selectedModelsBySession = new Map<string, string>()

// 当前活跃的 Trace ID
let currentTraceId: string | null = null

// 已经发起过 trace-create 的 trace，避免多轮 chat.message 重复创建同一条 trace。
const uploadedTraceIds = new Set<string>()

// 数据上报失败后写入本地 outbox，后续后台重试，避免正常成功路径频繁读写本地文件。
const failedIngestionEvents: any[] = []
let retryingFailedIngestionEvents = false
let failedIngestionQueueFile = join(TESTAGENT_DATA_DIR, "langfuse-ingestion-queue.json")
let failedIngestionQueueLoaded = false
const MAX_FAILED_INGESTION_EVENTS = 5000
let handlersInstalled = false // testagent_change
const BACKGROUND_INGESTION_BATCH_SIZE = 50
const FAILED_INGESTION_RETRY_BATCH_SIZE = 50
const FAILED_INGESTION_RETRY_DELAY_MS = 1000
const MAX_BACKGROUND_INGESTION_EVENTS = 10000
let backgroundIngestionEvents: any[] = []
let backgroundIngestionDrainPromise: Promise<void> | null = null
let backgroundIngestionDrainScheduled = false

// 最终完整 trace 汇总上报到后端批处理接口，用于兼容 Kafka 消费完整数据的逻辑。
const finalBatchUploads: any[] = []
let retryingFinalBatchUploads = false
let finalBatchUploadQueueFile = join(TESTAGENT_DATA_DIR, "langfuse-final-batch-upload-queue.json")
let finalBatchUploadQueueLoaded = false
const MAX_FINAL_BATCH_UPLOADS = 1000
const BACKGROUND_FINAL_BATCH_UPLOAD_SIZE = 100
const MAX_BACKGROUND_FINAL_BATCH_UPLOADS = 1000
let backgroundFinalBatchUploads: any[] = []
let backgroundFinalBatchDrainPromise: Promise<void> | null = null
let backgroundFinalBatchDrainScheduled = false

function getActiveParentId(): string | undefined {
  const activeSkill = skillStack[skillStack.length - 1]
  return activeSkill?.context.spanId
}

function getCurrentSkillContext(): SkillContext | null {
  return skillStack[skillStack.length - 1]?.context ?? null
}

function getLatestActiveGeneration(sessionId: string): GenInfo | undefined {
  const active = activeGenerations.get(sessionId)
  return active?.[active.length - 1]
}

function getNextFinishingGeneration(sessionId: string): GenInfo | undefined {
  const active = activeGenerations.get(sessionId)
  return active?.find((g) => !g.finalOutput) ?? active?.[0]
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
  }

  return part.type === "step-finish" ? getNextFinishingGeneration(sessionId) : getLatestActiveGeneration(sessionId)
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
  if (oldTraceId === newTraceId || traceBatches.has(newTraceId)) return

  const batch = traceBatches.get(oldTraceId)
  if (batch) {
    batch.id = newTraceId
    for (const gen of batch.generations) gen.traceId = newTraceId
    for (const span of batch.spans) span.traceId = newTraceId
    traceBatches.delete(oldTraceId)
    traceBatches.set(newTraceId, batch)
  }

  const genList = gens.get(oldTraceId)
  if (genList) {
    for (const gen of genList) gen.traceId = newTraceId
    gens.delete(oldTraceId)
    gens.set(newTraceId, genList)
  }

  const genIndex = currentGenIdx.get(oldTraceId)
  if (genIndex !== undefined) {
    currentGenIdx.delete(oldTraceId)
    currentGenIdx.set(newTraceId, genIndex)
  }

  for (const gen of allGenerations) {
    if (gen.traceId === oldTraceId) gen.traceId = newTraceId
  }
  for (const active of activeGenerations.values()) {
    for (const gen of active) {
      if (gen.traceId === oldTraceId) gen.traceId = newTraceId
    }
  }
  for (const context of skillStack) {
    if (context.context.traceId === oldTraceId) context.context.traceId = newTraceId
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
  if (currentTraceId === oldTraceId) currentTraceId = newTraceId
  uploadedTraceIds.delete(oldTraceId)
  generatedTraceIds.delete(oldTraceId)
}

function getTraceIdForSession(sessionId: string, preferredTraceId?: string): string {
  const existing = sessionToTrace.get(sessionId)
  if (existing) {
    if (
      preferredTraceId &&
      sessionId === rootSessionId &&
      existing !== preferredTraceId &&
      generatedTraceIds.has(existing)
    ) {
      migrateTraceId(existing, preferredTraceId)
      return preferredTraceId
    }
    return existing
  }

  if (!rootSessionId) {
    rootSessionId = sessionId
  }

  const rootTraceId = rootSessionId ? sessionToTrace.get(rootSessionId) : undefined
  const traceId = rootTraceId ?? preferredTraceId ?? generateUUID()
  if (!rootTraceId && !preferredTraceId) generatedTraceIds.add(traceId)

  sessionToTrace.set(sessionId, traceId)
  if (sessionId === rootSessionId || !currentTraceId) {
    currentTraceId = traceId
  }

  return traceId
}

function getSessionObservationParent(
  sessionId: string,
  options?: { preferActiveGeneration?: boolean },
): string | undefined {
  if (options?.preferActiveGeneration) {
    const activeGeneration = getLatestActiveGeneration(sessionId)
    if (activeGeneration) return activeGeneration.genId
  }

  const agentSpanId = sessionToAgentSpan.get(sessionId)
  if (agentSpanId) return agentSpanId

  const skillContext = getCurrentSkillContext()
  if (skillContext) return skillContext.spanId

  return getActiveParentId()
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

async function attachSubagentSession(sessionId: string, traceId: string, agentSpanId: string) {
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
  for (const gen of allGenerations.filter((g) => g.sessionId === sessionId && g.traceId === traceId)) {
    if (gen.parentObservationId === agentSpanId) continue
    gen.parentObservationId = agentSpanId
    const generationUpdates: Partial<GenerationData> = { parentObservationId: agentSpanId }
    updateGenerationInBatch(traceId, gen.genId, generationUpdates)
    updateGenerationImmediately(traceId, gen.genId, generationUpdates)
  }

  for (const spanId of sessionSpanIds.get(sessionId) ?? []) {
    const span = traceBatches.get(traceId)?.spans.find((s) => s.id === spanId)
    if (!span || span.id === agentSpanId || span.parentObservationId === agentSpanId) continue
    const spanUpdates: Partial<SpanData> = { parentObservationId: agentSpanId }
    updateSpanInBatch(traceId, spanId, spanUpdates)
    updateSpanImmediately(traceId, spanId, spanUpdates)
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

// 消息计数器
const messageCounter = new Map<string, number>()

// Langfuse credentials (will be updated from project keys)
let publicKey: string
let secretKey: string
let currentBatchProjectId = "fallback_project"
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
  return text.replace(/TESTCASE_ID/g, () => `TC${generateUUID().replace(/-/g, "")}`)
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

function withEventBodyTags(event: any) {
  if (!event || typeof event !== "object" || !event.body) return event
  return {
    ...event,
    body: withEventMetadataTags(event.body),
  }
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf-8")
}

function splitIngestionEventsBySize(events: any[], maxBytes: number): any[][] {
  const chunks: any[][] = []
  let current: any[] = []
  let currentBytes = jsonByteLength({ batch: [] })

  for (const event of events) {
    const eventBytes = jsonByteLength(event) + 1
    if (current.length > 0 && currentBytes + eventBytes > maxBytes) {
      chunks.push(current)
      current = []
      currentBytes = jsonByteLength({ batch: [] })
    }

    current.push(event)
    currentBytes += eventBytes
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}

async function uploadToIngestion(events: any[]) {
  if (events.length === 0) return { successes: [], errors: [] }

  const taggedEvents = events.map(withEventBodyTags)
  const chunks = splitIngestionEventsBySize(taggedEvents, MAX_INGESTION_BATCH_BYTES)
  if (chunks.length > 1) {
    const successes: any[] = []
    const errors: any[] = []
    for (const chunk of chunks) {
      const result = await uploadToIngestionChunk(chunk)
      successes.push(...(Array.isArray(result.successes) ? result.successes : []))
      errors.push(...(Array.isArray(result.errors) ? result.errors : []))
    }
    return { successes, errors }
  }

  return uploadToIngestionChunk(taggedEvents)
}

async function uploadToIngestionChunk(taggedEvents: any[]) {
  if (taggedEvents.length === 0) return { successes: [], errors: [] }

  const body = JSON.stringify({ batch: taggedEvents })
  const credentials = btoa(`${publicKey}:${secretKey}`)
  const traceId = taggedEvents?.[0]?.body?.traceId || taggedEvents?.[0]?.body?.id
  const projectId = taggedEvents?.[0]?.body?.metadata?.projectId
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
        tags: {
          eventCount: String(taggedEvents.length),
          ...(traceId ? { traceId } : {}),
          ...(projectId ? { projectId } : {}),
        },
      })
      return { successes: taggedEvents.map((event) => ({ id: event.id })), errors: [] }
    }

    const text = await readResponseTextSafe(res)
    trackEvent("both", {
      level: "error",
      message: res.status === 413 ? "数据上报失败，请求体过大" : "数据上报失败",
      data: {
        status: res.status,
        eventCount: taggedEvents.length,
        traceId,
        projectId,
      },
      metricName: "plugin.langfuse.ingestion.error",
      metricValue: 1,
      tags: {
        status: String(res.status),
        eventCount: String(taggedEvents.length),
        reason: res.status === 413 ? "payload_too_large" : "request_failed",
      },
    })
    return { successes: [], errors: taggedEvents.map((event) => ({ id: event.id, status: res.status, error: text })) }
  } catch (e) {
    trackEvent("both", {
      level: "error",
      message: "数据上报异常",
      data: {
        error: String(e),
        traceId,
        projectId,
      },
      metricName: "plugin.langfuse.ingestion.error",
      metricValue: 1,
      tags: {
        error: "exception",
      },
    })
    return { successes: [], errors: taggedEvents.map((event) => ({ id: event.id, status: 500, error: String(e) })) }
  }
}

async function postJsonWithAuth(path: string, payload: any, timeoutMs = LANGFUSE_FETCH_TIMEOUT_MS) {
  const credentials = btoa(`${publicKey}:${secretKey}`)
  try {
    const res = await fetchWithTimeout(`${LANGFUSE_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify(payload),
    }, timeoutMs)

    if (res.ok) {
      return { ok: true, body: null }
    }

    const text = await readResponseTextSafe(res)
    return { ok: false, status: res.status, error: text }
  } catch (e) {
    const isTimeout = e instanceof Error && e.name === "AbortError"
    return { ok: false, status: isTimeout ? 408 : 500, error: String(e), reason: isTimeout ? "timeout" : "exception" }
  }
}

function buildFinalBatchUpload(batch: TraceBatch) {
  if (!batch.output) {
    const finalOutput = getFinalTraceOutput(batch.id, batch.sessionId) ?? getFinalTraceOutputFromBatch(batch)
    if (finalOutput) batch.output = finalOutput
  }

  const events: any[] = [buildIngestionEvent("trace-create", traceEventBody(batch))]

  const sortedGenerations = [...batch.generations].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
  )
  const sortedSpans = [...batch.spans].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())

  for (const generation of sortedGenerations) {
    events.push(buildIngestionEvent("generation-create", generationEventBody(generation), generation.startTime))
  }

  for (const span of sortedSpans) {
    events.push(buildIngestionEvent("span-create", spanEventBody(span), span.startTime))
  }

  return events
}

function getFinalBatchUploadTraceId(item: any): string | undefined {
  return item?.body?.traceId || item?.body?.id
}

function configureFinalBatchUploadQueue(projectKey: string) {
  const safeProjectKey = projectKey.replace(/[^a-zA-Z0-9_-]/g, "_")
  finalBatchUploadQueueFile = join(TESTAGENT_DATA_DIR, `langfuse-final-batch-upload-queue-${safeProjectKey}.json`)
  finalBatchUploadQueueLoaded = false
  finalBatchUploads.splice(0)
}

function persistFinalBatchUploads() {
  try {
    mkdirSync(dirname(finalBatchUploadQueueFile), { recursive: true })
    const tmpFile = `${finalBatchUploadQueueFile}.tmp`
    writeFileSync(tmpFile, JSON.stringify(finalBatchUploads, null, 2), "utf-8")
    renameSync(tmpFile, finalBatchUploadQueueFile)
  } catch (e) {
    trackEvent("both", {
      level: "error",
      message: "持久化最终批次上传队列失败",
      data: { error: String(e) },
      metricName: "plugin.langfuse.persist.error",
      metricValue: 1,
      tags: { type: "finalBatchUpload", action: "persist", reason: "exception" },
    })
  }
}

function isValidFinalBatchUpload(item: any) {
  return (
    !!item &&
    typeof item === "object" &&
    typeof item.id === "string" &&
    ["trace-create", "generation-create", "span-create"].includes(item.type) &&
    !!item.body
  )
}

function enqueueFinalBatchUploads(items: any[], options?: { persist?: boolean }) {
  if (items.length === 0) return

  const existingIds = new Set(finalBatchUploads.map((item) => item.id))
  for (const item of items) {
    if (!isValidFinalBatchUpload(item) || existingIds.has(item.id)) continue
    finalBatchUploads.push(withEventBodyTags(item))
    existingIds.add(item.id)
  }

  const maxQueueSize = Math.max(MAX_FINAL_BATCH_UPLOADS, items.length)
  if (finalBatchUploads.length > maxQueueSize) {
    finalBatchUploads.splice(0, finalBatchUploads.length - maxQueueSize)
  }

  if (options?.persist !== false) {
    persistFinalBatchUploads()
  }
}

function replaceFinalBatchUploads(items: any[]) {
  finalBatchUploads.splice(0, finalBatchUploads.length, ...items)
  persistFinalBatchUploads()
}

function takeNextFinalBatchUploadGroup(queue: any[]): any[] {
  if (queue.length === 0) return []

  const firstTraceId = getFinalBatchUploadTraceId(queue[0])
  if (!firstTraceId) {
    return queue.splice(0, BACKGROUND_FINAL_BATCH_UPLOAD_SIZE)
  }

  const group: any[] = []
  for (let i = 0; i < queue.length; ) {
    const item = queue[i]
    if (getFinalBatchUploadTraceId(item) === firstTraceId) {
      group.push(item)
      queue.splice(i, 1)
    } else {
      i += 1
    }
  }

  return group
}

function loadFinalBatchUploadsFromDisk() {
  if (finalBatchUploadQueueLoaded) return
  finalBatchUploadQueueLoaded = true
  if (!existsSync(finalBatchUploadQueueFile)) {
    trackEvent("metric", {
      metricName: "plugin.langfuse.queue.load.success",
      metricValue: 1,
      tags: { type: "finalBatchUpload", status: "missing_file" },
    })
    return
  }

  try {
    const raw = readFileSync(finalBatchUploadQueueFile, "utf-8")
    const persistedItems = JSON.parse(raw)
    if (!Array.isArray(persistedItems)) {
      trackEvent("both", {
        level: "warn",
        message: "加载最终批次上传队列，数据格式异常",
        data: { file: finalBatchUploadQueueFile },
        metricName: "plugin.langfuse.load.error",
        metricValue: 1,
        tags: { type: "finalBatchUpload", reason: "invalid_format" },
      })
      return
    }

    enqueueFinalBatchUploads(persistedItems.filter(isValidFinalBatchUpload), { persist: false })
    persistFinalBatchUploads()
    trackEvent("metric", {
      metricName: "plugin.langfuse.queue.load.success",
      metricValue: 1,
      tags: {
        type: "finalBatchUpload",
        status: "loaded",
        itemCount: String(persistedItems.filter(isValidFinalBatchUpload).length),
      },
    })
  } catch (e) {
    trackEvent("both", {
      level: "error",
      message: "加载最终批次上传队列异常",
      data: { error: String(e), file: finalBatchUploadQueueFile },
      metricName: "plugin.langfuse.load.error",
      metricValue: 1,
      tags: { type: "finalBatchUpload", reason: "exception" },
    })
  }
}

async function uploadFinalBatchItems(items: any[]) {
  if (items.length === 0) return []

  const taggedItems = items.map(withEventBodyTags)
  const result = await postJsonWithAuth(
    LANGFUSE_FINAL_BATCH_UPLOAD_PATH,
    { json: { [currentBatchProjectId]: taggedItems } },
    LANGFUSE_FINAL_BATCH_UPLOAD_TIMEOUT_MS,
  )
  if(result.ok) {
    trackEvent("metric", {
      metricName: "plugin.langfuse.upload.final.success",
      metricValue: 1,
      tags: { itemCount: String(taggedItems.length) },
    })
  }else{
    trackEvent("both", {
      level: "error",
      message: "最终批次上传失败",
      data: { itemCount: taggedItems.length, error: result.error },
      metricName: "plugin.langfuse.upload.final.error",
      metricValue: 1,
      tags: { itemCount: String(taggedItems.length), reason: result.reason ?? "request_failed", status: String(result.status ?? 0) },
    })
  }

  return result.ok ? [] : taggedItems
}

async function retryFinalBatchUploads() {
  if (!ENABLE_FINAL_BATCH_UPLOAD) return
  loadFinalBatchUploadsFromDisk()
  if (retryingFinalBatchUploads || finalBatchUploads.length === 0) return

  retryingFinalBatchUploads = true
  const items = [...finalBatchUploads]
  try {
    const failedItems = await uploadFinalBatchItems(items)
    const failedIds = new Set(failedItems.map((item) => item.id))
    replaceFinalBatchUploads(
      finalBatchUploads.filter(
        (item) => !items.some((attempted) => attempted.id === item.id) || failedIds.has(item.id),
      ),
    )
  } finally {
    retryingFinalBatchUploads = false
  }
}

function uploadFinalTraceBatch(batch: TraceBatch) {
  if (!ENABLE_FINAL_BATCH_UPLOAD) return
  const items = buildFinalBatchUpload(batch)
  scheduleBackgroundFinalBatchUpload(items)
}

function withEventMetadataTags(body: any) {
  if (!body || typeof body !== "object") return body

  return {
    ...body,
    tags: OBSERVATION_TAGS,
    metadata: {
      ...(body.metadata ?? {}),
      tags: OBSERVATION_TAGS,
    },
  }
}

function buildIngestionEvent(type: string, body: any, timestamp = new Date().toISOString()) {
  return {
    id: generateUUID(),
    timestamp,
    type,
    body: withEventMetadataTags(body),
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

function isValidIngestionEvent(event: any) {
  return (
    !!event &&
    typeof event === "object" &&
    typeof event.id === "string" &&
    typeof event.type === "string" &&
    !!event.body
  )
}

function configureFailedIngestionQueue(projectKey: string) {
  const safeProjectKey = projectKey.replace(/[^a-zA-Z0-9_-]/g, "_")
  failedIngestionQueueFile = join(TESTAGENT_DATA_DIR, `langfuse-ingestion-queue-${safeProjectKey}.json`)
  failedIngestionQueueLoaded = false
  failedIngestionEvents.splice(0)
}

function persistFailedIngestionEvents() {
  try {
    mkdirSync(dirname(failedIngestionQueueFile), { recursive: true })
    const tmpFile = `${failedIngestionQueueFile}.tmp`
    writeFileSync(tmpFile, JSON.stringify(failedIngestionEvents, null, 2), "utf-8")
    renameSync(tmpFile, failedIngestionQueueFile)
  } catch (e) {
    trackEvent("both", {
      level: "error",
      message: "持久化数据上报重试队列失败",
      data: { error: String(e) },
      metricName: "plugin.langfuse.persist.error",
      metricValue: 1,
      tags: { type: "ingestionRetryQueue", action: "persist", reason: "exception" },
    })
  }
}

function loadFailedIngestionEventsFromDisk() {
  if (failedIngestionQueueLoaded) return
  failedIngestionQueueLoaded = true
  if (!existsSync(failedIngestionQueueFile)) {
    trackEvent("metric", {
      metricName: "plugin.langfuse.queue.load.success",
      metricValue: 1,
      tags: { type: "ingestionRetryQueue", status: "missing_file" },
    })
    return
  }

  try {
    const raw = readFileSync(failedIngestionQueueFile, "utf-8")
    const persistedEvents = JSON.parse(raw)
    if (!Array.isArray(persistedEvents)) {
      trackEvent("both", {
        level: "warn",
        message: "加载重试队列，数据格式异常",
        data: { file: failedIngestionQueueFile },
        metricName: "plugin.langfuse.load.error",
        metricValue: 1,
        tags: { type: "ingestionRetryQueue", reason: "invalid_format" },
      })
      return
    }

    const validPersistedEvents = persistedEvents.filter(isValidIngestionEvent)
    enqueueFailedIngestionEvents(validPersistedEvents, { persist: false })
    if (validPersistedEvents.length !== persistedEvents.length) {
      persistFailedIngestionEvents()
    }
    trackEvent("metric", {
      metricName: "plugin.langfuse.queue.load.success",
      metricValue: 1,
      tags: {
        type: "ingestionRetryQueue",
        status: "loaded",
        eventCount: String(validPersistedEvents.length),
      },
    })
  } catch (e) {
    trackEvent("both", {
      level: "error",
      message: "加载重试队列异常",
      data: { error: String(e), file: failedIngestionQueueFile },
      metricName: "plugin.langfuse.load.error",
      metricValue: 1,
      tags: { type: "ingestionRetryQueue", reason: "exception" },
    })
  }
}

function enqueueFailedIngestionEvents(events: any[], options?: { persist?: boolean }) {
  if (events.length === 0) return

  const existingIds = new Set(failedIngestionEvents.map((event) => event.id))
  for (const event of events) {
    if (!isValidIngestionEvent(event) || existingIds.has(event.id)) continue
    failedIngestionEvents.push(withEventBodyTags(event))
    existingIds.add(event.id)
  }

  if (failedIngestionEvents.length > MAX_FAILED_INGESTION_EVENTS) {
    trackEvent("both", {
      level: "warn",
      message: "数据上报重试队列超过建议上限，暂不裁剪以避免数据丢失",
      data: { queueSize: failedIngestionEvents.length, maxQueueSize: MAX_FAILED_INGESTION_EVENTS },
      metricName: "plugin.langfuse.queue.size.warning",
      metricValue: 1,
      tags: {
        type: "ingestionRetryQueue",
        queueSize: String(failedIngestionEvents.length),
        maxQueueSize: String(MAX_FAILED_INGESTION_EVENTS),
      },
    })
  }

  if (options?.persist !== false) {
    persistFailedIngestionEvents()
  }
}

function replaceFailedIngestionEvents(events: any[]) {
  failedIngestionEvents.splice(0, failedIngestionEvents.length, ...events)
  persistFailedIngestionEvents()
}

function markIngestionEventsAttempted(events: any[], failedEvents: any[]) {
  const attemptedIds = new Set(events.map((event) => event.id))
  const failedIds = new Set(failedEvents.map((event) => event.id))
  const remainingEvents = failedIngestionEvents.filter(
    (event) => !attemptedIds.has(event.id) || failedIds.has(event.id),
  )
  replaceFailedIngestionEvents(remainingEvents)
}

async function retryFailedIngestionEvents() {
  loadFailedIngestionEventsFromDisk()
  if (retryingFailedIngestionEvents || failedIngestionEvents.length === 0) return

  retryingFailedIngestionEvents = true
  const events = failedIngestionEvents.slice(0, FAILED_INGESTION_RETRY_BATCH_SIZE)
  try {
    const result = await uploadToIngestion(events)
    const failedEvents = getFailedEvents(events, result)
    markIngestionEventsAttempted(events, failedEvents)
  } finally {
    retryingFailedIngestionEvents = false
  }
}

async function ingestEvents(events: any[], options?: { queueOnFailure?: boolean }) {
  if (events.length === 0) return { successes: [], errors: [] }

  const shouldPersistOutbox = options?.queueOnFailure !== false
  const result = await uploadToIngestion(events)
  const failedEvents = getFailedEvents(events, result)

  if (shouldPersistOutbox && failedEvents.length > 0) {
    enqueueFailedIngestionEvents(failedEvents)
  }

  return result
}

function scheduleBackgroundIngestion(events: any[]) {
  if (events.length === 0) return

  backgroundIngestionEvents.push(...events)
  if (backgroundIngestionEvents.length > MAX_BACKGROUND_INGESTION_EVENTS) {
    const overflowEvents = backgroundIngestionEvents.splice(0, backgroundIngestionEvents.length - MAX_BACKGROUND_INGESTION_EVENTS)
    enqueueFailedIngestionEvents(overflowEvents)
  }

  scheduleBackgroundIngestionDrain()
}

function scheduleBackgroundIngestionDrain(delayMs = 0) {
  if (backgroundIngestionDrainPromise || backgroundIngestionDrainScheduled) return

  backgroundIngestionDrainScheduled = true
  setTimeout(() => {
    backgroundIngestionDrainScheduled = false
    void drainBackgroundIngestion()
  }, delayMs)
}

async function drainBackgroundIngestion() {
  if (backgroundIngestionDrainPromise) return backgroundIngestionDrainPromise

  backgroundIngestionDrainPromise = (async () => {
    try {
      while (backgroundIngestionEvents.length > 0) {
        const events = backgroundIngestionEvents.splice(0, BACKGROUND_INGESTION_BATCH_SIZE)
        await ingestEvents(events, { queueOnFailure: true })
      }
      await retryFailedIngestionEvents()
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
      if (backgroundIngestionEvents.length > 0) {
        scheduleBackgroundIngestionDrain()
      } else if (failedIngestionEvents.length > 0) {
        scheduleBackgroundIngestionDrain(FAILED_INGESTION_RETRY_DELAY_MS)
      }
    }
  })()

  return backgroundIngestionDrainPromise
}

function scheduleBackgroundFinalBatchUpload(items: any[]) {
  if (!ENABLE_FINAL_BATCH_UPLOAD) return
  if (items.length === 0) return

  backgroundFinalBatchUploads.push(...items)
  const maxQueueSize = Math.max(MAX_BACKGROUND_FINAL_BATCH_UPLOADS, items.length)
  if (backgroundFinalBatchUploads.length > maxQueueSize) {
    backgroundFinalBatchUploads.splice(0, backgroundFinalBatchUploads.length - maxQueueSize)
  }

  scheduleBackgroundFinalBatchDrain()
}

function scheduleBackgroundFinalBatchDrain() {
  if (!ENABLE_FINAL_BATCH_UPLOAD) return
  if (backgroundFinalBatchDrainPromise || backgroundFinalBatchDrainScheduled) return

  backgroundFinalBatchDrainScheduled = true
  setTimeout(() => {
    backgroundFinalBatchDrainScheduled = false
    void drainBackgroundFinalBatchUploads()
  }, 0)
}

async function drainBackgroundFinalBatchUploads() {
  if (!ENABLE_FINAL_BATCH_UPLOAD) return
  if (backgroundFinalBatchDrainPromise) return backgroundFinalBatchDrainPromise

  backgroundFinalBatchDrainPromise = (async () => {
    try {
      await retryFinalBatchUploads()
      while (backgroundFinalBatchUploads.length > 0) {
        const items = takeNextFinalBatchUploadGroup(backgroundFinalBatchUploads)
        enqueueFinalBatchUploads(items)

        const failedItems = await uploadFinalBatchItems(items)
        if (failedItems.length === 0) {
          const uploadedIds = new Set(items.map((item) => item.id))
          replaceFinalBatchUploads(finalBatchUploads.filter((queuedItem) => !uploadedIds.has(queuedItem.id)))
        }
      }
    } catch (e) {
      trackEvent("both", {
        level: "error",
        message: "后台最终批次上传失败",
        data: { error: String(e) },
        metricName: "plugin.langfuse.upload.background.error",
        metricValue: 1,
        tags: { type: "backgroundFinalBatchUpload", reason: "exception" },
      })
    } finally {
      backgroundFinalBatchDrainPromise = null
      if (backgroundFinalBatchUploads.length > 0) {
        scheduleBackgroundFinalBatchDrain()
      }
    }
  })()

  return backgroundFinalBatchDrainPromise
}

async function flushBackgroundUploads() {
  await drainBackgroundIngestion()
  await drainBackgroundFinalBatchUploads()
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

function upsertTraceImmediately(batch: TraceBatch) {
  const type = uploadedTraceIds.has(batch.id) ? "trace-update" : "trace-create"
  scheduleBackgroundIngestion([buildIngestionEvent(type, traceEventBody(batch))])
  uploadedTraceIds.add(batch.id)
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
  scheduleBackgroundIngestion([buildIngestionEvent("generation-create", generationEventBody(gen), gen.startTime)])
}

function updateGenerationImmediately(traceId: string, genId: string, updates: Partial<GenerationData>) {
  const modelMetadata = updates.metadata?.model ?? {}
  scheduleBackgroundIngestion([
    buildIngestionEvent("generation-update", {
      id: genId,
      traceId,
      selectedModel: modelMetadata.selectedModel,
      resolvedModel: modelMetadata.resolvedModel,
      ...updates,
    }),
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

function createSpanImmediately(span: SpanData) {
  scheduleBackgroundIngestion([buildIngestionEvent("span-create", spanEventBody(span), span.startTime)])
}

function updateSpanImmediately(traceId: string, spanId: string, updates: Partial<SpanData>) {
  scheduleBackgroundIngestion([buildIngestionEvent("span-update", { id: spanId, traceId, ...updates })])
}

function hasOwn(obj: any, key: string) {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key)
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

async function updateToolSpanOutput(
  traceId: string,
  spanId: string,
  endTime: Date,
  snapshot: { output: any; metadata?: any; title?: string },
) {
  const existingSpan = traceBatches.get(traceId)?.spans.find((span) => span.id === spanId)
  const spanOutput = toSpanOutput(snapshot.output)
  const spanUpdates: Partial<SpanData> = {
    ...(spanOutput !== undefined ? { output: spanOutput } : {}),
    endTime: endTime.toISOString(),
    level: snapshot.output === null ? "ERROR" : "DEFAULT",
    metadata: {
      ...(existingSpan?.metadata || {}),
      spanKind: "TOOL",
      nodeType: existingSpan?.metadata?.nodeType || "tool",
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
      }
      toolResultSnapshots.set(callID, snapshot)
      await updateToolSpanOutputFromSnapshot(
        callID,
        sessionId ? sessionToTrace.get(sessionId) : currentTraceId,
        new Date(),
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
  snapshot: { output: any; metadata?: any; title?: string },
) {
  const callInfo = toolCallInfos.get(callID)
  const spanId = callInfo?.spanId ?? toolSpanIds.get(callID)
  const resolvedTraceId = callInfo?.traceId ?? traceId
  if (!spanId || !resolvedTraceId) return false

  await updateToolSpanOutput(resolvedTraceId, spanId, endTime, snapshot)
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

function buildGenerationText(g: GenInfo) {
  const textContent = g.parts
    .filter((p) => !p.startsWith("Tool Call:") && !p.startsWith("Tool Result:") && !p.startsWith("Reasoning:"))
    .join("\n\n")
  const reasonText = g.parts
    .filter((p) => p.startsWith("Reasoning:"))
    .map((p) => p.replace(/^Reasoning: /, ""))
    .join("\n")

  const combinedText = reasonText ? `<think>\n${reasonText}\n</think>\n\n${textContent}` : textContent
  return combinedText || g.output || ""
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
  const endTime = options?.endTime ?? new Date()

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
    : undefined

  const toolCallsOutput = g.toolCalls.map((tc) => ({
    type: "function",
    function: {
      name: tc.name,
      arguments: tc.args || {},
    },
  }))

  const structuredOutput = {
    text: fullText,
    tool_calls: toolCallsOutput.length > 0 ? toolCallsOutput : undefined,
    usage: toOutputUsage(usage),
    finish_reason: options?.finishReason,
  }

  const cachedMessages = llmInputs.get(sessionId)
  const metadataMessages = g.input?.messages || []
  const system = systemPrompts.get(sessionId) || []
  const tools = [...allToolDefs.values()]

  let fullInputMessages: any[] = []
  if (cachedMessages && cachedMessages.length > 0) {
    const built = buildLLMInput(cachedMessages, system, tools)
    fullInputMessages = (built.dict as any).messages || []
  } else if (metadataMessages.length > 0) {
    fullInputMessages = metadataMessages
  }

  const hasToolResult = fullInputMessages.some((m: any) => m.role === "tool")
  if (!hasToolResult && g.toolResults && g.toolResults.length > 0) {
    const toolResultMessages = g.toolResults.map((tr: any) => ({
      role: "tool",
      content: [{ type: "tool-result", content: tr.output }],
    }))
    fullInputMessages = [...fullInputMessages, ...toolResultMessages]
  }

  const updatedInput = {
    messages: fullInputMessages,
    tools: g.input?.tools || [],
  }

  const generationUpdates: Partial<GenerationData> = {
    endTime: endTime.toISOString(),
    completionStartTime: g.completionStartTime?.toISOString(),
    ...(usage ? { usage } : {}),
    output: JSON.stringify(structuredOutput, null, 2),
    modelParameters: {
      ...g.modelParameters,
      ...(options?.finishReason ? { finish_reason: options.finishReason } : {}),
    },
    tags: [...OBSERVATION_TAGS, ...(options?.finishReason ? [`finish_reason:${options.finishReason}`] : [])],
    metadata: {
      spanKind: "LLM",
      model: buildLLMModelMetadata(g),
      input: updatedInput,
      output: structuredOutput,
      ...(usage
        ? {
            usage: {
              unit: "tokens",
              scope: "generation",
              note:
                "Langfuse generation usage is per LLM call. Input includes uncached input plus cache read/write; output includes visible output plus reasoning.",
              ...(normalizedUsage?.details ? { details: normalizedUsage.details } : {}),
              ...usage,
            },
          }
        : {}),
      tags: OBSERVATION_TAGS,
      ...baseMetadata(),
    },
  }

  updateGenerationInBatch(g.traceId, g.genId, generationUpdates)
  updateGenerationImmediately(g.traceId, g.genId, generationUpdates)

  g.finalOutput = structuredOutput
  g.hasUsage = !!usage
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
    upsertTraceImmediately(batch)
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
  await flushBackgroundUploads()
  await retryFinalBatchUploads()
}

// testagent_change start - install process-level handlers only once across plugin instances
function installProcessHandlers() {
  if (handlersInstalled) return
  handlersInstalled = true

  const flush = async () => {
    await flushAllTraces()
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
    await flushAllTraces()
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
    await flushAllTraces()
  })
}
// testagent_change end

/**
 * 添加 generation 到批次
 */
function addGenerationToBatch(traceId: string, gen: GenerationData) {
  const batch = traceBatches.get(traceId)
  if (batch) {
    batch.generations.push(gen)
  }
}

/**
 * 添加 span 到批次
 */
function addSpanToBatch(traceId: string, span: SpanData) {
  const batch = traceBatches.get(traceId)
  if (batch) {
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
    batch.generations[idx] = { ...batch.generations[idx], ...updates } as GenerationData
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
    batch.spans[idx] = { ...batch.spans[idx], ...updates } as SpanData
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

function convertToLLMMessages(messages: any[]): any[] {
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
function buildLLMInput(messages: any[], system: string[], tools: any[]): { json: string; dict: object } {
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

// ==================== 插件主逻辑 ====================

export const LangfusePlugin: Plugin = async (ctx) => {
  const extendedCtx = ctx as unknown as ExtendedPluginInput
  pluginLog = extendedCtx.log
  pluginMetric = extendedCtx.metric

  const user = User.get()
  let project_id: string | null = null
  publicKey = "pk-lf-d89067e9-5eb3-42cc-b947-2d82a1a9e181"
  secretKey = "sk-lf-773528e2-aa24-48d0-9791-b7f795cbfb9a"
  if (user.userId && user.userName) {
    userIdMetadata = `${user.userName}/${user.userId}`
    const applyProjectApiKeys = (apiKeys: ProjectApiKeys, source: "cache" | "server") => {
      project_id = apiKeys.project_id
      publicKey = apiKeys.public_key
      secretKey = apiKeys.secret_key
      currentBatchProjectId = apiKeys.project_id
      trackEvent("metric", {
        metricName: "plugin.langfuse.client.init.success",
        metricValue: 1,
        tags: { source, projectId: apiKeys.project_id },
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
  currentBatchProjectId = project_id || "fallback_project"

  configureFailedIngestionQueue(publicKey)
  configureFinalBatchUploadQueue(publicKey)
  scheduleBackgroundIngestionDrain()
  scheduleBackgroundFinalBatchDrain()

  installProcessHandlers() // testagent_change

  return {
    /**
     * 处理聊天消息事件
     */
    "chat.message": async (input, output) => {
      const sessionId = getSessionId(input.sessionID)
      trackedSessionIds.add(sessionId)

      if (!rootSessionId) {
        rootSessionId = sessionId
      }

      const traceId = getTraceIdForSession(sessionId, sessionId === rootSessionId ? input.messageID : undefined)
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

      const batch = createTraceBatch(rootSessionId, textContent || "message", ctx, traceId)
      if (isAssistantMessage && sessionId === rootSessionId) {
        const finalText = stripThinkTags(assistantOutput)
        if (finalText) batch.output = finalText
      }
      updateTraceBatch(traceId, {
        ...(isAssistantMessage && sessionId === rootSessionId && stripThinkTags(assistantOutput)
          ? { output: stripThinkTags(assistantOutput) }
          : {}),
        metadata: {
          ...batch.metadata,
          messageID: input.messageID,
          messageIndex: count,
          isSubagent: sessionId !== rootSessionId,
          input: {
            sessionID: input.sessionID,
            agent: input.agent,
            model: input.model,
            messageID: input.messageID,
            variant: input.variant,
          },
          output: {
            message: output.message,
            parts: output.parts,
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
      const messageMetadata = (input.message as any)?.metadata
      const inputMetadata = (input as any)?.metadata
      const pastToolCalls = messageMetadata?.PasttoolCalls ?? inputMetadata?.PasttoolCalls ?? []
      if (Array.isArray(pastToolCalls) && pastToolCalls.length > 0) {
        const hasSkillCall = pastToolCalls.some((tc: any) => tc?.name === "skill" || tc?.tool === "skill")
        if (hasSkillCall && skillStack.length > 0) {
          const popped = skillStack.pop()
          if (popped) {
            toolSpanIds.delete(popped.callID)
            toolCallInfos.delete(popped.callID)
            toolResultSnapshots.delete(popped.callID)
          }
        }
      }

      const sessionId = getSessionId(input.sessionID)
      const traceId = getTraceIdForSession(sessionId)
      const parentObservationId = getSessionObservationParent(sessionId)

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
        input: llmInputDict,
        output: {},
        tags: OBSERVATION_TAGS,
        ...(commandMeta ? {commandData: commandMeta} : {}),
        ...baseMetadata(),
      }

      // 添加 generation 数据到批次
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

      addGenerationToBatch(traceId, genData)
      createGenerationImmediately(genData)

      // 记录 GenInfo
      const genInfo: GenInfo = {
        traceId,
        genId,
        sessionId,
        parentObservationId,
        selectedModel,
        resolvedModel,
        modelName,
        startTime,
        completionStartTime: null,
        stepNumber: (gens.get(traceId)?.length || 0) + 1,
        output: "",
        parts: [],
        toolCalls: [],
        isSkillChild: !!getCurrentSkillContext(),
        hasUsage: false,
        finalOutput: null,
        modelParameters,
        input: llmInputDict,
      }

      const genList = gens.get(traceId) || []
      genList.push(genInfo)
      gens.set(traceId, genList)

      allGenerations.push(genInfo)
      addActiveGeneration(sessionId, genInfo)
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

      const sessionId = input.sessionID || currentSessionId || [...trackedSessionIds].pop()
      if (!sessionId) return

      const traceId = getTraceIdForSession(sessionId)
      const rootSid = rootSessionId || sessionId

      const isSkill = input.tool === "skill"
      const isTask = input.tool === "task"
      const subagentType = output.args?.subagent_type
      const toolParentObservationId = getSessionObservationParent(sessionId)
      const agentParentObservationId = getSessionObservationParent(sessionId)

      if (!traceBatches.has(traceId)) {
        const batch = createTraceBatch(rootSid, userInputs.get(rootSid) || "tool execution", ctx, traceId)
        upsertTraceImmediately(batch)
      }

      const spanId = generateUUID()
      const skillName = output.args?.name || output.args?.skill || "skill"
      const spanName = isSkill ? `skill:${skillName}` : `tool:${input.tool}`
      const startTime = new Date()

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
          input: {
            tool: input.tool,
            args: output.args,
          },
          ...baseMetadata(),
        },
        tags: OBSERVATION_TAGS,
      }

      addSpanToBatch(traceId, spanData)
      createSpanImmediately(spanData)
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
        const currentParentId = getActiveParentId()
        const skillContext: SkillContext = {
          spanId,
          traceId,
          gens: [],
          parentSpanId: currentParentId, // 记录父 span，用于嵌套
          isSubagent: true, // 标记为 subagent
        }
        skillStack.push({ callID: input.callID, context: skillContext })
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

      let skillName = "skill"
      let skillDesc = ""
      if (skillYamlInfo) {
        skillName = skillYamlInfo.name
        skillDesc = skillYamlInfo.description
      }
      const endTime = new Date()

      const toolDef = allToolDefs.get(input.tool)
      const cachedResult = toolResultSnapshots.get(input.callID)
      const effectiveOutput =
        (output.output === null || output.output === undefined) && cachedResult?.output != null
          ? cachedResult.output
          : output.output
      const effectiveTitle = output.title ?? cachedResult?.title
      const effectiveMetadata = output.metadata ?? cachedResult?.metadata

      const spanOutput = toSpanOutput(effectiveOutput)

      const spanUpdates: Partial<SpanData> = {
        ...(spanOutput !== undefined ? { output: spanOutput } : {}),
        endTime: endTime.toISOString(),
        level: effectiveOutput === null ? "ERROR" : "DEFAULT",
        metadata: {
          spanKind: "TOOL",
          nodeType: isSkill ? "skill" : "tool",
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

      updateSpanInBatch(traceId, spanId, spanUpdates)
      updateSpanImmediately(traceId, spanId, spanUpdates)

      if (!isSkill && effectiveOutput !== null && effectiveOutput !== undefined) {
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

      const g = getLatestActiveGeneration(sessionId)
      if (!g) return

      g.output = output.text

      const generationUpdates: Partial<GenerationData> = {
        output: output.text,
        metadata: {
          spanKind: "LLM",
          model: buildLLMModelMetadata(g),
          input: g.input,
          output: { text: output.text },
          tags: OBSERVATION_TAGS,
          ...baseMetadata(),
        },
      }

      updateGenerationInBatch(g.traceId, g.genId, generationUpdates)
      updateGenerationImmediately(g.traceId, g.genId, generationUpdates)
    },

    /**
     * 通用事件处理器
     */
    event: async (input: any) => {
      const evt = input?.event
      if (!evt) return

      // 服务器实例销毁时，刷新所有数据
      if (evt.type === "server.instance.disposed") {
        await flushAllTraces()
        return
      }

      // 会话创建时，建立主从session关系
      if (evt.type === "session.created") {
        const sid = evt.properties?.info?.id
        const parentId = evt.properties?.info?.parentID
        if (sid) {
          trackedSessionIds.add(sid)
          if (!rootSessionId) {
            rootSessionId = sid
          }

          if (parentId) {
            const pending = consumePendingSubagent(parentId)
            const inheritedTraceId = pending?.traceId || sessionToTrace.get(parentId) || currentTraceId
            if (inheritedTraceId) {
              sessionToTrace.set(sid, inheritedTraceId)
              currentTraceId = inheritedTraceId
            }
            if (pending?.agentSpanId) {
              await attachSubagentSession(sid, pending.traceId, pending.agentSpanId)
            } else {
              rememberPendingSubagentSession(parentId, sid)
            }
            // console.log("[langfuse] subagent session created:", sid, "parent:", parentId, "using trace:", inheritedTraceId)
          }
        }
      }

      if (evt.type === "message.part.updated" && evt.properties?.part) {
        const part = evt.properties.part
        const sessionId = part.sessionID || currentSessionId
        if (!sessionId) return

        if (part.type === "tool" && part.callID && part.state?.status === "completed" && hasOwn(part.state, "output")) {
          const snapshot = {
            output: part.state.output,
            metadata: part.metadata,
            title: part.title,
          }
          toolResultSnapshots.set(part.callID, snapshot)

          await updateToolSpanOutputFromSnapshot(
            part.callID,
            sessionToTrace.get(sessionId) || currentTraceId,
            new Date(),
            snapshot,
          )
        }

        const g = getActiveGenerationForPart(sessionId, part)

        if (g && part.type !== "step-finish") {
          if (part.type === "text" && part.text) {
            if (!g.completionStartTime) {
              g.completionStartTime = new Date()
              const generationUpdates = { completionStartTime: g.completionStartTime.toISOString() }
              updateGenerationInBatch(g.traceId, g.genId, generationUpdates)
              updateGenerationImmediately(g.traceId, g.genId, generationUpdates)
            }
            g.parts.push(part.text)
          }
          if (part.type === "reasoning" && part.text) {
            if (!g.completionStartTime) {
              g.completionStartTime = new Date()
              const generationUpdates = { completionStartTime: g.completionStartTime.toISOString() }
              updateGenerationInBatch(g.traceId, g.genId, generationUpdates)
              updateGenerationImmediately(g.traceId, g.genId, generationUpdates)
            }
            g.parts.push(`Reasoning: ${part.text}`)
          }
          if (part.type === "tool" && part.state?.status === "running") {
            if (!g.completionStartTime) {
              g.completionStartTime = new Date()
              const generationUpdates = { completionStartTime: g.completionStartTime.toISOString() }
              updateGenerationInBatch(g.traceId, g.genId, generationUpdates)
              updateGenerationImmediately(g.traceId, g.genId, generationUpdates)
            }
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
          if (part.reason !== "tool-calls" && skillStack.length > 0) {
            const popped = skillStack.pop()
            if (popped) {
              toolSpanIds.delete(popped.callID)
              toolCallInfos.delete(popped.callID)
              toolResultSnapshots.delete(popped.callID)
            }
          }

          await finalizeGeneration(sessionId, g, {
            tokens: part.tokens,
            endTime: new Date(),
            finishReason: part.reason,
          })
        }
      }

      if (evt.type === "session.idle") {
        const idleSessionId = evt.sessionID ?? evt.properties?.sessionID
        const sessionId = idleSessionId || currentSessionId || [...trackedSessionIds].pop()
        if (!sessionId) return

        const traceId =
          sessionToTrace.get(sessionId) ||
          currentTraceId ||
          (rootSessionId ? sessionToTrace.get(rootSessionId) : undefined)
        if (!traceId) return

        if (sessionId !== rootSessionId) {
          for (const g of allGenerations.filter(
            (gen) => gen.sessionId === sessionId && gen.traceId === traceId && !gen.finalOutput,
          )) {
            await finalizeGeneration(sessionId, g)
          }

          const agentSpanId = sessionToAgentSpan.get(sessionId)
          if (agentSpanId) {
            const childGenerations = allGenerations.filter(
              (g) => g.parentObservationId === agentSpanId && g.traceId === traceId,
            )
            const lastChildGeneration = childGenerations[childGenerations.length - 1]
            const spanUpdates: Partial<SpanData> = {
              endTime: new Date().toISOString(),
              output: lastChildGeneration?.finalOutput?.text || userInputs.get(sessionId),
            }
            updateSpanInBatch(traceId, agentSpanId, spanUpdates)
            updateSpanImmediately(traceId, agentSpanId, spanUpdates)
            sessionToAgentSpan.delete(sessionId)
          }

          activeGenerations.delete(sessionId)
          sessionSpanIds.delete(sessionId)
          llmInputs.delete(sessionId)
          systemPrompts.delete(sessionId)
          userInputs.delete(sessionId)
          sessionAssistantOutputs.delete(sessionId)
          messageCounter.delete(sessionId)
          return
        }

        for (const g of allGenerations) {
          if (!g.finalOutput) {
            await finalizeGeneration(g.sessionId || sessionId, g)
          }
        }

        const currentBatch = traceBatches.get(traceId)
        const finalText =
          getFinalTraceOutput(traceId, rootSessionId) ??
          (currentBatch ? getFinalTraceOutputFromBatch(currentBatch) : undefined)
        if (finalText !== undefined) {
          updateTraceBatch(traceId, { output: finalText })
          const batch = traceBatches.get(traceId)
          if (batch) {
            upsertTraceImmediately(batch)
          }
        }

        const finalBatch = traceBatches.get(traceId)
        if (finalBatch) {
          uploadFinalTraceBatch(finalBatch)
        }

        scheduleBackgroundIngestionDrain()
        scheduleBackgroundFinalBatchDrain()

        traceBatches.delete(traceId)
        gens.delete(traceId)
        skillStack.length = 0
        skillCache.clear()
        sessionIdMap.clear()
        activeGenerations.clear()
        toolSpanIds.clear()
        toolCallInfos.clear()
        toolResultSnapshots.clear()
        sessionSpanIds.clear()
        allGenerations.length = 0
        allToolDefs.clear()
        messageCounter.clear()
        userInputs.clear()
        sessionAssistantOutputs.clear()
        llmInputs.clear()
        systemPrompts.clear()
        trackedSessionIds.clear()
        sessionToAgentSpan.clear()
        pendingSubagents.clear()
        pendingSubagentSessions.clear()
        uploadedTraceIds.delete(traceId)
        currentTraceId = null
        rootSessionId = null
        sessionToTrace.clear()
        generatedTraceIds.clear()
      }

      if (evt.type === "session.error") {
        const sessionId = evt.sessionID || currentSessionId
        if (sessionId) {
          const traceId = sessionToTrace.get(sessionId) || currentTraceId
          if (traceId) {
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
