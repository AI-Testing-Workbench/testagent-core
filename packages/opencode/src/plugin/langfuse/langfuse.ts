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

import type { Plugin } from "@opencode-ai/plugin"
import { Effect, Schema } from "effect"
import { User } from "@/testagent/user"
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from "fs"
import { dirname, join } from "path"
import { homedir } from "os"

const LANGFUSE_BASE_URL = decodeURIComponent(
  atob("aHR0cCUzQSUyRiUyRnRlc3RodWItYWdlbnQtdHJhY2UucGFhc3VhdC5jbWJjaGluYS5jbg=="),
)
const LANGFUSE_FINAL_BATCH_UPLOAD_PATH = "/api/trpc/batchTrace.save"

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

// 单节点即时上传前先写入本地 outbox，成功后再删除，避免进程崩溃导致事件丢失。
const failedIngestionEvents: any[] = []
let retryingFailedIngestionEvents = false
let failedIngestionQueueFile = join(homedir(), ".testagent", "langfuse-ingestion-queue.json")
let failedIngestionQueueLoaded = false
const MAX_FAILED_INGESTION_EVENTS = 5000
let handlersInstalled = false // testagent_change

// 最终完整 trace 汇总上报到后端批处理接口，用于兼容 Kafka 消费完整数据的逻辑。
const finalBatchUploads: any[] = []
let retryingFinalBatchUploads = false
let finalBatchUploadQueueFile = join(homedir(), ".testagent", "langfuse-final-batch-upload-queue.json")
let finalBatchUploadQueueLoaded = false
const MAX_FINAL_BATCH_UPLOADS = 500

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

function queuePendingSubagent(parentSessionId: string, entry: { traceId: string; agentSpanId: string }) {
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

// 存储用户输入
const userInputs = new Map<string, string>()

// 存储每个 session 最后一条 assistant 输出，用于 trace 根节点 output 兜底
const sessionAssistantOutputs = new Map<string, string>()

// 存储 LLM 输入消息
const llmInputs = new Map<string, any[]>()

// 存储 system prompt
const systemPrompts = new Map<string, string[]>()

// 全局工具定义缓存
const allToolDefs = new Map<string, { id: string; description: string; parameters: any }>()

// 存储当前生成的索引
const currentGenIdx = new Map<string, number>()

// 跟踪的会话 ID 集合
const trackedSessionIds = new Set<string>()

// 消息计数器
const messageCounter = new Map<string, number>()

// Langfuse credentials (will be updated from project keys)
let publicKey: string
let secretKey: string
let currentProjectId = "unknown_project"
let userIdMetadata: string | null = null

// ==================== 常量 ====================

const OBSERVATION_TAGS = ["testagent"]

// ==================== write/edit/bash 内容转换 ====================

// write/edit: 匹配 filePath 参数，要求以支持的扩展名结尾
const BASE_FILE_RE = /测试案例[/\\].+\.(yaml|yml)$/

// bash: 匹配 command 字符串中被单引号或双引号包裹的路径片段
const BASH_FILE_RE = /测试案例[/\\].+\.(yaml|yml)['"]/

function isBaseFile(filePath: unknown): filePath is string {
  return typeof filePath === "string" && BASE_FILE_RE.test(filePath)
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

function withEventBodyTags(event: any) {
  if (!event || typeof event !== "object" || !event.body) return event
  return {
    ...event,
    body: withEventMetadataTags(event.body),
  }
}

async function uploadToIngestion(events: any[]) {
  // console.log("进入uploadToIngestion")
  if (events.length === 0) return { successes: [], errors: [] }

  const taggedEvents = events.map(withEventBodyTags)
  const body = JSON.stringify({ batch: taggedEvents })
  // console.log("body", body)
  const credentials = btoa(`${publicKey}:${secretKey}`)
  // console.log("credentials", credentials)
  try {
    const res = await fetch(`${LANGFUSE_BASE_URL}/api/public/ingestion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
        Authorization: `Basic ${credentials}`,
      },
      body,
    })

    //console.log("已发送/api/public/ingestion接口")
    if (res.ok) {
      //console.log("[langfuse] Ingestion success")
      return { successes: taggedEvents.map((event) => ({ id: event.id })), errors: [] }
    }

    const text = await readResponseTextSafe(res)
    //console.error("[langfuse] Ingestion failed", { status: res.status, body: text })
    return { successes: [], errors: [{ id: "batch", status: res.status, error: text }] }
  } catch (e) {
    //console.error("[langfuse] Ingestion error", e)
    return { successes: [], errors: [{ id: "batch", status: 500, error: String(e) }] }
  }
}

async function postJsonWithAuth(path: string, payload: any) {
  const credentials = btoa(`${publicKey}:${secretKey}`)
  try {
    const res = await fetch(`${LANGFUSE_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify(payload),
    })

    if (res.ok) {
      return { ok: true, body: null }
    }

    const text = await readResponseTextSafe(res)
    return { ok: false, status: res.status, error: text }
  } catch (e) {
    return { ok: false, status: 500, error: String(e) }
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

function configureFinalBatchUploadQueue(projectKey: string) {
  const safeProjectKey = projectKey.replace(/[^a-zA-Z0-9_-]/g, "_")
  finalBatchUploadQueueFile = join(homedir(), ".testagent", `langfuse-final-batch-upload-queue-${safeProjectKey}.json`)
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
    console.error("[langfuse] Failed to persist final batch upload queue", e)
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

  if (finalBatchUploads.length > MAX_FINAL_BATCH_UPLOADS) {
    finalBatchUploads.splice(0, finalBatchUploads.length - MAX_FINAL_BATCH_UPLOADS)
  }

  if (options?.persist !== false) {
    persistFinalBatchUploads()
  }
}

function replaceFinalBatchUploads(items: any[]) {
  finalBatchUploads.splice(0, finalBatchUploads.length, ...items)
  persistFinalBatchUploads()
}

function loadFinalBatchUploadsFromDisk() {
  if (finalBatchUploadQueueLoaded) return
  finalBatchUploadQueueLoaded = true
  if (!existsSync(finalBatchUploadQueueFile)) return

  try {
    const raw = readFileSync(finalBatchUploadQueueFile, "utf-8")
    const persistedItems = JSON.parse(raw)
    if (!Array.isArray(persistedItems)) return

    enqueueFinalBatchUploads(persistedItems.filter(isValidFinalBatchUpload), { persist: false })
    persistFinalBatchUploads()
  } catch (e) {
    console.error("[langfuse] Failed to load final batch upload queue", e)
  }
}

async function uploadFinalBatchItems(items: any[]) {
  if (items.length === 0) return []

  const taggedItems = items.map(withEventBodyTags)
  const result = await postJsonWithAuth(LANGFUSE_FINAL_BATCH_UPLOAD_PATH, { json: { [currentProjectId]: taggedItems } })
  return result.ok ? [] : taggedItems
}

async function retryFinalBatchUploads() {
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

async function uploadFinalTraceBatch(batch: TraceBatch) {
  await retryFinalBatchUploads()

  const items = buildFinalBatchUpload(batch)
  enqueueFinalBatchUploads(items)

  const failedItems = await uploadFinalBatchItems(items)
  if (failedItems.length === 0) {
    const uploadedIds = new Set(items.map((item) => item.id))
    replaceFinalBatchUploads(finalBatchUploads.filter((queuedItem) => !uploadedIds.has(queuedItem.id)))
  }
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
  failedIngestionQueueFile = join(homedir(), ".testagent", `langfuse-ingestion-queue-${safeProjectKey}.json`)
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
    // Avoid breaking agent execution if local persistence is temporarily unavailable.
    console.error("[langfuse] Failed to persist ingestion retry queue", e)
  }
}

function loadFailedIngestionEventsFromDisk() {
  if (failedIngestionQueueLoaded) return
  failedIngestionQueueLoaded = true
  if (!existsSync(failedIngestionQueueFile)) return

  try {
    const raw = readFileSync(failedIngestionQueueFile, "utf-8")
    const persistedEvents = JSON.parse(raw)
    if (!Array.isArray(persistedEvents)) return

    enqueueFailedIngestionEvents(persistedEvents.filter(isValidIngestionEvent), { persist: false })
    persistFailedIngestionEvents()
  } catch (e) {
    console.error("[langfuse] Failed to load ingestion retry queue", e)
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
    failedIngestionEvents.splice(0, failedIngestionEvents.length - MAX_FAILED_INGESTION_EVENTS)
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
  const events = [...failedIngestionEvents]
  try {
    const result = await uploadToIngestion(events)
    const failedEvents = getFailedEvents(events, result)
    markIngestionEventsAttempted(events, failedEvents)
  } finally {
    retryingFailedIngestionEvents = false
  }
}

async function ingestEvents(events: any[], options?: { retryQueued?: boolean; queueOnFailure?: boolean }) {
  if (events.length === 0) return { successes: [], errors: [] }

  if (options?.retryQueued !== false) {
    await retryFailedIngestionEvents()
  }

  const shouldPersistOutbox = options?.queueOnFailure !== false
  if (shouldPersistOutbox) {
    enqueueFailedIngestionEvents(events)
  }

  const result = await uploadToIngestion(events)
  const failedEvents = getFailedEvents(events, result)

  if (shouldPersistOutbox) {
    markIngestionEventsAttempted(events, failedEvents)
  }

  return result
}

async function ingestEvent(type: string, body: any, timestamp?: string) {
  return ingestEvents([buildIngestionEvent(type, body, timestamp)])
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
  }
}

async function upsertTraceImmediately(batch: TraceBatch) {
  const type = uploadedTraceIds.has(batch.id) ? "trace-update" : "trace-create"
  await ingestEvent(type, traceEventBody(batch))
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

async function createGenerationImmediately(gen: GenerationData) {
  await ingestEvent("generation-create", generationEventBody(gen), gen.startTime)
}

async function updateGenerationImmediately(traceId: string, genId: string, updates: Partial<GenerationData>) {
  const modelMetadata = updates.metadata?.model ?? {}
  await ingestEvent("generation-update", {
    id: genId,
    traceId,
    selectedModel: modelMetadata.selectedModel,
    resolvedModel: modelMetadata.resolvedModel,
    ...updates,
  })
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

async function createSpanImmediately(span: SpanData) {
  await ingestEvent("span-create", spanEventBody(span), span.startTime)
}

async function updateSpanImmediately(traceId: string, spanId: string, updates: Partial<SpanData>) {
  await ingestEvent("span-update", { id: spanId, traceId, ...updates })
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

function toSpanOutput(output: any) {
  if (output === undefined) return undefined
  if (output === null) return null
  return stringifyToolOutput(output).slice(0, 10000)
}

async function updateToolSpanOutputFromSnapshot(
  callID: string,
  traceId: string,
  endTime: Date,
  snapshot: { output: any; metadata?: any; title?: string },
) {
  const spanId = toolSpanIds.get(callID)
  if (!spanId) return false

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
  await updateSpanImmediately(traceId, spanId, spanUpdates)
  return true
}

function normalizeUsage(tokens: any): { input: number; output: number; total: number } | undefined {
  if (!tokens || typeof tokens !== "object") return undefined

  const input = tokens.input ?? tokens.inputTokens ?? tokens.promptTokens ?? tokens.prompt_tokens
  const output = tokens.output ?? tokens.outputTokens ?? tokens.completionTokens ?? tokens.completion_tokens
  const total = tokens.total ?? tokens.totalTokens ?? tokens.total_tokens

  if (input === undefined && output === undefined && total === undefined) return undefined

  const normalizedInput = Number(input ?? 0)
  const normalizedOutput = Number(output ?? 0)
  const normalizedTotal = Number(total ?? normalizedInput + normalizedOutput)

  if (![normalizedInput, normalizedOutput, normalizedTotal].every(Number.isFinite)) return undefined

  return {
    input: normalizedInput,
    output: normalizedOutput,
    total: normalizedTotal,
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
  const usage = normalizeUsage(options?.tokens) ?? { input: 0, output: 0, total: 0 }

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
    usage,
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
      tags: OBSERVATION_TAGS,
      ...baseMetadata(),
    },
  }

  updateGenerationInBatch(g.traceId, g.genId, generationUpdates)
  await updateGenerationImmediately(g.traceId, g.genId, generationUpdates)

  g.finalOutput = structuredOutput
  g.hasUsage = true
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
    await upsertTraceImmediately(batch)
    await retryFailedIngestionEvents()
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
  await retryFailedIngestionEvents()
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
    console.error("[langfuse] Uncaught exception:", err)
    await flushAllTraces()
    process.exit(1)
  })
  process.on("unhandledRejection", async (reason) => {
    console.error("[langfuse] Unhandled rejection:", reason)
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
          toolCalls.push({
            type: "function",
            function: {
              name: p.tool,
              arguments: p.state.input,
            },
          })
        }
        if (p.state?.status === "completed" && p.state?.output !== undefined) {
          toolResults.push({
            role: "tool",
            name: p.tool,
            content: p.state.output,
          })
        } else if (p.state?.status === "error" && p.state?.error) {
          toolResults.push({
            role: "tool",
            name: p.tool,
            content: `Error: ${p.state.error}`,
          })
        }
      } else if (p.type === "tool-call") {
        flushTextBuffer()
        toolCalls.push({
          type: "function",
          function: {
            name: p.name,
            arguments: p.args || {},
          },
        })
      } else if (p.type === "tool-result") {
        flushTextBuffer()
        toolResults.push({
          role: "tool",
          name: p.name || "",
          content: p.output,
        })
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
    return {
      type: "function",
      function: {
        name: t.name || t.id || t,
        description: t.description || "",
        parameters: toJsonSchema(t.parameters || { type: "object", properties: {} }),
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

function loadSkillRaw(dir: string, name: string): { raw: string; yaml: Record<string, any>; content: string } | null {
  const cacheKey = `${dir}::${name}`
  if (skillCache.has(cacheKey)) return skillCache.get(cacheKey)!

  let filePath: string | null = null
  if (existsSync(`${dir}/SKILL.md`)) {
    filePath = `${dir}/SKILL.md`
  } else if (existsSync(`${dir}/skill.md`)) {
    filePath = `${dir}/skill.md`
  }
  if (!filePath) return null

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

async function signup_user(user_id: string, user_name: string, langfuse_host: string): Promise<void> {
  const res = await fetch(`${langfuse_host}/api/auth/sign-up`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([
      {
        name: `${user_name}/${user_id}`,
        email: `${user_id}${decodeURIComponent(atob("JTQwY21iY2hpbmEuY29t"))}`,
        password: `${user_id}${decodeURIComponent(atob("JTQwY21iY2hpbmEuY29t"))}`,
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

  const csrfRes = await fetch(`${langfuse_host}/api/auth/csrf`)
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

  const credentialsRes = await fetch(`${langfuse_host}/api/auth/callback/credentials`, {
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
    const res = await fetch(`${langfuse_host}/api/trpc/organizations.create`, {
      method: "POST",
      headers: { Cookie: session, "Content-Type": "application/json" },
      body: JSON.stringify({ json: { name: "TestAgent", appId: "", channel: "testagent" } }),
    })
    const resJson = await res.json()
    return resJson.result.data.json.id
  } catch (e) {
    console.error(`[langfuse] 创建organization失败:${e}`)
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
    let res = await fetch(`${langfuse_host}/api/trpc/projects.create`, {
      method: "POST",
      headers: { Cookie: session, "Content-Type": "application/json" },
      body: JSON.stringify({
        json: { name: `${user_name}/${user_id}`, orgId: org_id, appId: "", techId: "", channel: "testagent" },
      }),
    })
    let resJson = await res.json()
    const project_id = resJson.result.data.json.id

    res = await fetch(`${langfuse_host}/api/trpc/projectApiKeys.create`, {
      method: "POST",
      headers: { Cookie: session, "Content-Type": "application/json" },
      body: JSON.stringify({ json: { projectId: project_id } }),
    })
    resJson = await res.json()
    const public_key = resJson.result.data.json.publicKey
    const secret_key = resJson.result.data.json.secretKey
    return { public_key, secret_key, project_id }
  } catch (e) {
    console.error(`[langfuse] 创建project失败:${e}`)
    return null
  }
}

async function get_apikeys_by_user(
  user_id: string,
  user_name: string,
  langfuse_host: string,
): Promise<{ public_key: string; secret_key: string; project_id: string } | null> {
  try {
    const res = await fetch(`${langfuse_host}/api/trpc/projectApiKeys.byUserInfo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: { userInfo: `${user_name}/${user_id}` } }),
    })
    const resJson = await res.json()
    const public_key = resJson.result.data.json.publicKey
    const secret_key = resJson.result.data.json.secretKey
    const project_id = resJson.result.data.json.projectId
    return { public_key, secret_key, project_id }
  } catch (e) {
    console.error(`[langfuse] 获取密钥信息失败:${e}`)
    return null
  }
}

async function get_project_apikeys(
  user_id: string,
  user_name: string,
  langfuse_host: string,
): Promise<{ public_key: string; secret_key: string; project_id: string } | null> {
  let result = await get_apikeys_by_user(user_id, user_name, langfuse_host)
  if (result?.public_key && result?.secret_key) {
    return result
  }

  const session = await get_langfuse_login_token(langfuse_host, user_id)
  const org_id = await create_organization(session, langfuse_host)
  if (org_id) {
    result = await create_project(user_id, user_name, org_id, session, langfuse_host)
    if (result?.public_key && result?.secret_key) {
      return result
    }
  }
  return null
}

// ==================== 插件主逻辑 ====================

export const LangfusePlugin: Plugin = async (ctx) => {
  const user = User.get()
  let project_id: string | null = null
  publicKey = "pk-lf-d89067e9-5eb3-42cc-b947-2d82a1a9e181"
  secretKey = "sk-lf-773528e2-aa24-48d0-9791-b7f795cbfb9a"
  if (user.id && user.name) {
    userIdMetadata = `${user.name}/${user.id}`
    try {
      const apiKeys = await get_project_apikeys(user.id, user.name, LANGFUSE_BASE_URL)
      if (apiKeys) {
        project_id = apiKeys.project_id
        ;((publicKey = apiKeys.public_key),
          (secretKey = apiKeys.secret_key),
          console.log("[langfuse] Client initialized with dynamic keys", { userId: user.id }))
      }
    } catch (e) {}
  }

  baseMetadata = () => {
    const m: Record<string, string> = {}
    if (project_id) m.projectId = project_id
    if (userIdMetadata) m.user_id = userIdMetadata
    if (currentSessionId) m["sessionId"] = currentSessionId
    m.source = "testagent"
    return m
  }
  currentProjectId = project_id || "unknown_project"

  configureFailedIngestionQueue(publicKey)
  configureFinalBatchUploadQueue(publicKey)
  await retryFailedIngestionEvents()
  await retryFinalBatchUploads()

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
      await upsertTraceImmediately(batch)
    },

    /**
     * 缓存最终发给 LLM 的上下文消息
     */
    "experimental.chat.messages.transform": async (_, output) => {
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

      const startTime = new Date()
      const genId = generateUUID()

      const modelParameters: Record<string, any> = {}
      if (output.temperature !== undefined) modelParameters.temperature = output.temperature
      if (output.topP !== undefined) modelParameters.top_p = output.topP
      if (output.topK !== undefined) modelParameters.top_k = output.topK
      if (output.maxOutputTokens !== undefined) modelParameters.max_tokens = output.maxOutputTokens

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
      await createGenerationImmediately(genData)

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
        await upsertTraceImmediately(batch)
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
      await createSpanImmediately(spanData)
      toolSpanIds.set(input.callID, spanId)

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
        await createSpanImmediately(agentSpanData)
        queuePendingSubagent(sessionId, { traceId, agentSpanId })

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
      if ((input.tool === "write" || input.tool === "edit") && isBaseFile(input.args?.filePath)) {
        const filePath: string = input.args.filePath
        try {
          const raw = readFileSync(filePath, "utf-8")
          if (raw.includes("TESTCASE_ID")) {
            fileContent = injectTestcaseIds(raw)
            writeFileSync(filePath, fileContent, "utf-8")
          }
        } catch (e) {
          // 文件读写失败时静默忽略，不影响正常流程
        }
      }
      if (input.tool === "bash" && typeof input.args?.command === "string" && BASH_FILE_RE.test(input.args.command)) {
        const match = input.args.command.match(/["']([^"']*测试案例[/\\][^"']+\.(yaml|yml))["']/)
        if (match) {
          const filePath = match[1]
          try {
            const raw = readFileSync(filePath, "utf-8")
            if (raw.includes("TESTCASE_ID")) {
              fileContent = injectTestcaseIds(raw)
              writeFileSync(filePath, fileContent, "utf-8")
            }
          } catch (e) {
            // 文件读写失败时静默忽略
          }
        }
      }

      const spanId = toolSpanIds.get(input.callID)
      if (!spanId) return

      const traceId = sessionToTrace.get(input.sessionID) || currentTraceId
      if (!traceId) return

      const isSkill = input.tool === "skill"

      // 如果是 skill 工具，读取原始 SKILL.md
      let skillYamlInfo: Record<string, any> | undefined
      if (isSkill && output.metadata?.dir) {
        const skillName = input.args?.name || output.metadata.name
        const info = loadSkillRaw(output.metadata.dir, skillName)
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
          ...baseMetadata(),
        },
      }

      updateSpanInBatch(traceId, spanId, spanUpdates)
      await updateSpanImmediately(traceId, spanId, spanUpdates)

      if (!isSkill && effectiveOutput !== null && effectiveOutput !== undefined) {
        toolSpanIds.delete(input.callID)
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
      await updateGenerationImmediately(g.traceId, g.genId, generationUpdates)
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
              sessionToAgentSpan.set(sid, pending.agentSpanId)
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

          const traceId = sessionToTrace.get(sessionId) || currentTraceId
          if (traceId) {
            await updateToolSpanOutputFromSnapshot(part.callID, traceId, new Date(), snapshot)
          }
        }

        const g = getActiveGenerationForPart(sessionId, part)

        if (g && part.type !== "step-finish") {
          if (part.type === "text" && part.text) {
            if (!g.completionStartTime) {
              g.completionStartTime = new Date()
              const generationUpdates = { completionStartTime: g.completionStartTime.toISOString() }
              updateGenerationInBatch(g.traceId, g.genId, generationUpdates)
              await updateGenerationImmediately(g.traceId, g.genId, generationUpdates)
            }
            g.parts.push(part.text)
          }
          if (part.type === "reasoning" && part.text) {
            if (!g.completionStartTime) {
              g.completionStartTime = new Date()
              const generationUpdates = { completionStartTime: g.completionStartTime.toISOString() }
              updateGenerationInBatch(g.traceId, g.genId, generationUpdates)
              await updateGenerationImmediately(g.traceId, g.genId, generationUpdates)
            }
            g.parts.push(`Reasoning: ${part.text}`)
          }
          if (part.type === "tool" && part.state?.status === "running") {
            if (!g.completionStartTime) {
              g.completionStartTime = new Date()
              const generationUpdates = { completionStartTime: g.completionStartTime.toISOString() }
              updateGenerationInBatch(g.traceId, g.genId, generationUpdates)
              await updateGenerationImmediately(g.traceId, g.genId, generationUpdates)
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
            await updateSpanImmediately(traceId, agentSpanId, spanUpdates)
            sessionToAgentSpan.delete(sessionId)
          }

          activeGenerations.delete(sessionId)
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
            await upsertTraceImmediately(batch)
          }
        }

        const finalBatch = traceBatches.get(traceId)
        if (finalBatch) {
          await uploadFinalTraceBatch(finalBatch)
        }

        await retryFailedIngestionEvents()
        await retryFinalBatchUploads()

        traceBatches.delete(traceId)
        gens.delete(traceId)
        skillStack.length = 0
        skillCache.clear()
        sessionIdMap.clear()
        activeGenerations.clear()
        toolSpanIds.clear()
        toolResultSnapshots.clear()
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
              await upsertTraceImmediately(batch)
            }
            await retryFailedIngestionEvents()
          }
        }
      }
    },
  }
}

export default LangfusePlugin
