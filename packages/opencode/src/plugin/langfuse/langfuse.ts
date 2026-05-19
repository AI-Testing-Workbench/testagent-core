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

import { Plugin } from "@opencode-ai/plugin"
import { User } from "@/testagent/user"
import { readFileSync, existsSync } from "fs";

const LANGFUSE_BASE_URL = "http://testhub-agent-trace.paasuat.cmbchina.cn";

let baseMetadata: () => Record<string, string>

// ==================== 会话管理 ====================

let currentSessionId: string | null = null
let rootSessionId: string | null = null // 主session ID
const sessionToTrace = new Map<string, string>() // sessionId -> traceId
const sessionToAgentSpan = new Map<string, string>() // subagent session -> agent span id
const pendingSubagents = new Map<string, { traceId: string; agentSpanId: string }[]>() // parent session -> pending subagents

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
  parentObservationId?: string
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

// LIFO 栈，维护嵌套 skill 调用链
const skillStack: { callID: string; context: SkillContext }[] = []

// 全局 generation 列表
const allGenerations: GenInfo[] = []

// 当前活跃的 generation（按 session 维护，避免主/子 agent 相互覆盖）
const activeGenerations = new Map<string, GenInfo>()

// 当前活跃的 Trace ID
let currentTraceId: string | null = null

function getActiveParentId(): string | undefined {
  const activeSkill = skillStack[skillStack.length - 1]
  return activeSkill?.context.spanId
}

function getCurrentSkillContext(): SkillContext | null {
  return skillStack[skillStack.length - 1]?.context ?? null
}

function getTraceIdForSession(sessionId: string): string {
  const existing = sessionToTrace.get(sessionId)
  if (existing) return existing

  if (!rootSessionId) {
    rootSessionId = sessionId
  }

  const rootTraceId = rootSessionId ? sessionToTrace.get(rootSessionId) : undefined
  const traceId = rootTraceId ?? generateUUID()

  sessionToTrace.set(sessionId, traceId)
  if (sessionId === rootSessionId || !currentTraceId) {
    currentTraceId = traceId
  }

  return traceId
}

function getSessionObservationParent(sessionId: string, options?: { preferActiveGeneration?: boolean }): string | undefined {
  if (options?.preferActiveGeneration) {
    const activeGeneration = activeGenerations.get(sessionId)
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

// ==================== 常量 ====================

const OBSERVATION_TAGS = ["testagent"]

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
async function uploadToIngestion(events: any[]) {
  if (events.length === 0) return { successes: [], errors: [] }

  const body = JSON.stringify({ batch: events })
  const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString("base64")

  // console.log("[langfuse] Starting ingestion request", { eventCount: events.length, baseUrl: LANGFUSE_BASE_URL })

  try {
    // console.log("[langfuse] Sending fetch request...")
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const res = await fetch(`${LANGFUSE_BASE_URL}/api/public/ingestion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${credentials}`,
      },
      body,
      signal: controller.signal,
    })
    clearTimeout(timeout)

    // console.log("[langfuse] Ingestion response received", { status: res.status, ok: res.ok })

    if (res.ok) {
      const json = await res.json()
      // console.log("[langfuse] Ingestion success", json)
      return json
    }

    const text = await res.text()
    // console.error("[langfuse] Ingestion failed", { status: res.status, body: text })
    return { successes: [], errors: [{ id: "batch", status: res.status, error: text }] }
  } catch (e) {
    // console.error("[langfuse] Ingestion error", e)
    return { successes: [], errors: [{ id: "batch", status: 500, error: String(e) }] }
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

  // console.log("[langfuse] Flushing trace", {
  //   traceId,
  //   generations: batch.generations.length,
  //   spans: batch.spans.length,
  // })

  try {
    const events: any[] = []
    const timestamp = new Date().toISOString()

    events.push({
      id: generateUUID(),
      timestamp,
      type: "trace-create",
      body: {
        id: batch.id,
        name: batch.name,
        sessionId: batch.sessionId,
        input: batch.input,
        output: batch.output,
        tags: batch.tags,
        metadata: batch.metadata,
      },
    })

    const sortedGens = [...batch.generations].sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
    )
    const sortedSpans = [...batch.spans].sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
    )

    const idMap = new Map<string, string>()

    for (const gen of sortedGens) {
      const eventId = generateUUID()
      idMap.set(gen.id, eventId)

      events.push({
        id: eventId,
        timestamp: gen.startTime,
        type: "generation-create",
        body: {
          id: gen.id,
          traceId: gen.traceId,
          name: gen.name,
          model: gen.model,
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
        },
      })
    }

    for (const span of sortedSpans) {
      const eventId = generateUUID()
      idMap.set(span.id, eventId)

      events.push({
        id: eventId,
        timestamp: span.startTime,
        type: "span-create",
        body: {
          id: span.id,
          traceId: span.traceId,
          name: span.name,
          input: span.input,
          output: span.output,
          metadata: span.metadata,
          tags: span.tags,
          startTime: span.startTime,
          endTime: span.endTime,
          level: span.level,
          parentObservationId: span.parentObservationId,
        },
      })
    }

    const result = await uploadToIngestion(events)
    // console.log("[langfuse] Trace flushed", { traceId, result })
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
}

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

  const idx = batch.generations.findIndex(g => g.id === genId)
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

  const idx = batch.spans.findIndex(s => s.id === spanId)
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
        if (typeof p.text === "string") textBuffer += p.text
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
        email: `${user_id}@cmbchina.com`,
        password: `${user_id}@cmbchina.com`,
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
  const password = `${user_id}@cmbchina.com`
  const email = password.toLowerCase()

  const csrfRes = await fetch(`${langfuse_host}/api/auth/csrf`)
  const csrfJson = await csrfRes.json()
  const csrf_token = csrfJson.csrfToken

  const cookies: Record<string, string> = {}
  csrfRes.headers.get("set-cookie")?.split(",").forEach((cookie) => {
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
  credentialsRes.headers.get("set-cookie")?.split(",").forEach((cookie) => {
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
  let userIdMetadata: string | null = null
  publicKey = "pk-lf-d89067e9-5eb3-42cc-b947-2d82a1a9e181"
  secretKey = "sk-lf-773528e2-aa24-48d0-9791-b7f795cbfb9a"
  if (user.id && user.name) {
    userIdMetadata = `${user.name}/${user.id}`
    try {
      const apiKeys = await get_project_apikeys(user.id, user.name, LANGFUSE_BASE_URL)
      if (apiKeys) {
        project_id = apiKeys.project_id
        publicKey = apiKeys.public_key,
        secretKey = apiKeys.secret_key,
        console.log("[langfuse] Client initialized with dynamic keys", { userId: user.id })
      }
    } catch (e) {
    }
  }

  baseMetadata = () => {
    const m: Record<string, string> = {}
    if (project_id) m.projectId = project_id
    if (userIdMetadata) m.user_id = userIdMetadata
    if (currentSessionId) m["session.id"] = currentSessionId
    m.source = "testagent"
    return m
  }

  // 注册兜底机制：进程退出时刷新所有数据
  const exitHandler = async () => {
    // console.log("[langfuse] Process exiting, flushing all traces...")
    await flushAllTraces()
  }

  process.on("beforeExit", exitHandler)
  process.on("SIGINT", exitHandler)
  process.on("SIGTERM", exitHandler)

  // 异常处理：捕获未处理的异常并刷新数据
  process.on("uncaughtException", async (err) => {
    console.error("[langfuse] Uncaught exception:", err)
    await flushAllTraces()
    process.exit(1)
  })

  process.on("unhandledRejection", async (reason, promise) => {
    console.error("[langfuse] Unhandled rejection:", reason)
    await flushAllTraces()
  })

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

      const traceId = getTraceIdForSession(sessionId)
      const textContent = output.parts
        .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
        .map((p: any) => p.text)
        .join("\n")
      userInputs.set(sessionId, textContent)

      const count = (messageCounter.get(sessionId) || 0) + 1
      messageCounter.set(sessionId, count)

      const batch = createTraceBatch(rootSessionId, textContent || "message", ctx, traceId)
      updateTraceBatch(traceId, {
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
          }
        }
      }

      const sessionId = getSessionId(input.sessionID)
      const traceId = getTraceIdForSession(sessionId)
      const parentObservationId = getSessionObservationParent(sessionId)

      const providerId = input.provider?.info?.id || "unknown"
      const modelId = input.model?.id || "unknown"
      const modelName = `${providerId}/${modelId}`

      const messages = llmInputs.get(sessionId) || []
      const system = systemPrompts.get(sessionId) || []
      const tools = [...allToolDefs.values()]
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
        model: {
          name: modelName,
          provider: providerId,
          id: modelId,
          parameters: modelParameters,
        },
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

      // 记录 GenInfo
      const genInfo: GenInfo = {
        traceId,
        genId,
        parentObservationId,
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
      activeGenerations.set(sessionId, genInfo)
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
        createTraceBatch(rootSid, userInputs.get(rootSid) || "tool execution", ctx, traceId)
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
      const spanId = toolSpanIds.get(input.callID)
      if (!spanId) return

      const traceId = sessionToTrace.get(input.sessionID) || currentTraceId
      if (!traceId) return

      const isSkill = input.tool === "skill"
      const level = output.output === null ? "ERROR" : "DEFAULT"

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

      updateSpanInBatch(traceId, spanId, {
        output: output.output === null ? null : String(output.output).slice(0, 10000),
        endTime: endTime.toISOString(),
        level,
        metadata: {
          spanKind: "TOOL",
          nodeType: isSkill ? "skill" : "tool",
          tags: OBSERVATION_TAGS,
          output: {
            title: output.title,
            output: output.output,
            metadata: output.metadata,
            ...(skillYamlInfo && { yaml: skillYamlInfo }),
          },
          input: {
            name: isSkill ? skillName : input.tool,
            args: input.args,
            description: isSkill ? skillDesc : toolDef?.description,
            input_schema: isSkill ? {} :toolDef
              ? {
                  parameters: toJsonSchema(toolDef.parameters || { type: "object", properties: {} })
                }
              : undefined,
          },
          ...baseMetadata(),
        },
      })

      if (!isSkill) {
        toolSpanIds.delete(input.callID)
      }
    },

    /**
     * 文本补全事件
     */
    "experimental.text.complete": async (input, output) => {
      const sessionId = input.sessionID || currentSessionId
      if (!sessionId) return

      const g = activeGenerations.get(sessionId)
      if (!g) return

      g.output = output.text

      updateGenerationInBatch(g.traceId, g.genId, {
        output: output.text,
        metadata: {
          spanKind: "LLM",
          model: {
            name: g.modelName,
            provider: g.modelName.split("/")[0],
            id: g.modelName.split("/")[1],
            parameters: g.modelParameters,
          },
          input: g.input,
          output: { text: output.text },
          tags: OBSERVATION_TAGS,
          ...baseMetadata(),
        },
      })
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

        const g = activeGenerations.get(sessionId)

        if (g && part.type !== "step-finish") {
          if (part.type === "text" && part.text) {
            if (!g.completionStartTime) {
              g.completionStartTime = new Date()
              updateGenerationInBatch(g.traceId, g.genId, {
                completionStartTime: g.completionStartTime.toISOString(),
              })
            }
            g.parts.push(part.text)
          }
          if (part.type === "reasoning" && part.text) {
            if (!g.completionStartTime) {
              g.completionStartTime = new Date()
              updateGenerationInBatch(g.traceId, g.genId, {
                completionStartTime: g.completionStartTime.toISOString(),
              })
            }
            g.parts.push(`Reasoning: ${part.text.substring(0, 500)}`)
          }
          if (part.type === "tool" && part.state?.status === "running") {
            if (!g.completionStartTime) {
              g.completionStartTime = new Date()
              updateGenerationInBatch(g.traceId, g.genId, {
                completionStartTime: g.completionStartTime.toISOString(),
              })
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
          if (part.type === "tool" && part.state?.status === "completed" && part.state?.output) {
            g.parts.push(`Tool Result: ${part.state.output?.substring(0, 1000) || ""}`)
            if (!g.toolResults) g.toolResults = []
            g.toolResults.push({
              toolCallId: part.callID || "",
              name: part.tool || "",
              output: part.state.output || "",
              metadata: part.metadata,
              index: g.toolCalls.findIndex((tc) => tc.toolCallId === (part.callID || "")),
              args: g.toolCalls.find((tc) => tc.toolCallId === (part.callID || ""))?.args || {},
            })
          }
        }

        if (part.type === "step-finish" && part.tokens && g) {
          if (part.reason !== "tool-calls" && skillStack.length > 0) {
            const popped = skillStack.pop()
            if (popped) {
              toolSpanIds.delete(popped.callID)
            }
          }

          const endTime = new Date()

          if (!g.completionStartTime) {
            g.completionStartTime = endTime
            updateGenerationInBatch(g.traceId, g.genId, {
              completionStartTime: endTime.toISOString(),
            })
          }

          // 从 parts 中提取内容
          const textContent = g.parts
            .filter((p) => !p.startsWith("Tool Call:") && !p.startsWith("Tool Result:") && !p.startsWith("Reasoning:"))
            .join("\n\n")
          const reasonText = g.parts
            .filter((p) => p.startsWith("Reasoning:"))
            .map((p) => p.replace(/^Reasoning: /, ""))
            .join("\n")
          const fullText = reasonText ? `${reasonText}\n\n${textContent}` : textContent

          const toolCallsOutput = g.toolCalls.map((tc) => ({
            // id: tc.toolCallId || `call_${Math.random().toString(36).substring(2, 12)}`,
            type: "function",
            function: {
              name: tc.name,
              arguments: tc.args || {},
            },
          }))

          const structuredOutput = {
            text: fullText,
            tool_calls: toolCallsOutput.length > 0 ? toolCallsOutput : undefined,
            usage: {
              input_tokens: part.tokens.input ?? 0,
              output_tokens: part.tokens.output ?? 0,
              total_tokens: part.tokens.total ?? 0,
            },
          }

          // 构建 input messages
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

          updateGenerationInBatch(g.traceId, g.genId, {
            endTime: endTime.toISOString(),
            usage: {
              input: part.tokens.input ?? 0,
              output: part.tokens.output ?? 0,
              total: part.tokens.total ?? 0,
            },
            output: JSON.stringify(structuredOutput, null, 2),
            metadata: {
              spanKind: "LLM",
              model: {
                name: g.modelName,
                provider: g.modelName.split("/")[0],
                id: g.modelName.split("/")[1],
                parameters: g.modelParameters,
              },
              input: updatedInput,
              output: structuredOutput,
              tags: OBSERVATION_TAGS,
              ...baseMetadata(),
            },
          })

          g.finalOutput = structuredOutput
          g.hasUsage = true
          activeGenerations.delete(sessionId)
        }
      }

      if (evt.type === "session.idle") {
        const idleSessionId = evt.sessionID ?? evt.properties?.sessionID
        const sessionId = idleSessionId || currentSessionId || [...trackedSessionIds].pop()
        if (!sessionId) return

        const traceId = sessionToTrace.get(sessionId) || currentTraceId || (rootSessionId ? sessionToTrace.get(rootSessionId) : undefined)
        if (!traceId) return

        if (sessionId !== rootSessionId) {
          const agentSpanId = sessionToAgentSpan.get(sessionId)
          if (agentSpanId) {
            const childGenerations = allGenerations.filter((g) => g.parentObservationId === agentSpanId && g.traceId === traceId)
            const lastChildGeneration = childGenerations[childGenerations.length - 1]
            updateSpanInBatch(traceId, agentSpanId, {
              endTime: new Date().toISOString(),
              output: lastChildGeneration?.finalOutput?.text || userInputs.get(sessionId),
            })
            sessionToAgentSpan.delete(sessionId)
          }

          activeGenerations.delete(sessionId)
          llmInputs.delete(sessionId)
          systemPrompts.delete(sessionId)
          userInputs.delete(sessionId)
          messageCounter.delete(sessionId)
          return
        }

        for (const g of allGenerations) {
          if (!g.finalOutput) {
            const textContent = g.parts
              .filter((p) => !p.startsWith("Tool Call:") && !p.startsWith("Tool Result:") && !p.startsWith("Reasoning:"))
              .join("\n\n")
            const reasonText = g.parts
              .filter((p) => p.startsWith("Reasoning:"))
              .map((p) => p.replace(/^Reasoning: /, ""))
              .join("\n")
            const fullText = reasonText ? `reasoning\n${reasonText}\n\n${textContent}` : textContent

            const toolCallsOutput = g.toolCalls.map((tc) => ({
              id: tc.toolCallId || `call_${Math.random().toString(36).substring(2, 12)}`,
              type: "function",
              function: {
                name: tc.name,
                arguments: tc.args || {},
              },
            }))

            const out = {
              text: fullText || g.output,
              tool_calls: toolCallsOutput.length > 0 ? toolCallsOutput : undefined,
              usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            }

            updateGenerationInBatch(g.traceId, g.genId, {
              output: JSON.stringify(out, null, 2),
              metadata: {
                spanKind: "LLM",
                model: {
                  name: g.modelName,
                  provider: g.modelName.split("/")[0],
                  id: g.modelName.split("/")[1],
                  parameters: g.modelParameters,
                },
                output: out,
                tags: OBSERVATION_TAGS,
                ...baseMetadata(),
              },
            })

            g.finalOutput = out
          }
        }

        if (allGenerations.length > 0) {
          const last = allGenerations[allGenerations.length - 1]
          if (last && last.finalOutput) {
            const rawText = last.finalOutput.text || ""
            const finalText = rawText.replace(/reasoning[\s\S]*?reasoning/g, "").trim()
            updateTraceBatch(traceId, { output: finalText })
          }
        }

        await flushTrace(traceId)

        traceBatches.delete(traceId)
        gens.delete(traceId)
        skillStack.length = 0
        skillCache.clear()
        sessionIdMap.clear()
        activeGenerations.clear()
        toolSpanIds.clear()
        allGenerations.length = 0
        allToolDefs.clear()
        messageCounter.clear()
        userInputs.clear()
        llmInputs.clear()
        systemPrompts.clear()
        trackedSessionIds.clear()
        sessionToAgentSpan.clear()
        pendingSubagents.clear()
        currentTraceId = null
        rootSessionId = null
        sessionToTrace.clear()
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
            await flushTrace(traceId)
          }
        }
      }
    },
  }
}

export default LangfusePlugin
