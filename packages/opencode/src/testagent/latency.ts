import { Effect } from "effect"
import * as EffectLogger from "@opencode-ai/core/effect/logger"

/**
 * 全链路耗时探针（CLI 侧）。
 *
 * 目标：回答"到底是 LLM 慢，还是前端渲染慢"。
 *
 * 一次工具调用/文本增量会依次经过：
 *
 *   ① LLM 流式返回       (provider)
 *   ② CLI 写入 part      (session.updatePart / updatePartDelta)
 *   ③ sync 事件落库+广播 (sync.run)
 *   ④ 扩展宿主收到 SSE   (kilo-vscode KiloProvider)
 *   ⑤ 扩展转发 postMessage
 *   ⑥ webview 收到并写入 store
 *   ⑦ webview 渲染完成
 *
 * 各环节都会产出一条带统一 traceId 的日志，可以按 ID 串起来看：
 *
 *   [链路][a1b2c3d4] ② CLI写入part 类型=text 距LLM首字=3ms
 *   [链路][a1b2c3d4] ③ 事件入库 广播完成 耗时=1ms 类型=message.part.updated
 *
 * 输出通道：仅远端 OTLP（经 Observability.layer 上报到服务端），不写本地日志文件。
 * 需要 Effect 上下文，因此所有上报 API 都返回 Effect。
 *
 * 开关：默认开启；设置 TESTAGENT_LATENCY=0 可关闭。
 */

const ENABLED = process.env.TESTAGENT_LATENCY !== "0"

/** 同一条消息内共享的 trace 容器，key 为 sessionID:messageID:partID */
type Trace = {
  id: string
  /** ② CLI 写入 part 的时刻 */
  cliAt?: number
  /** ③ 事件广播完成的时刻 */
  syncAt?: number
  /** LLM 首个 token 到达时刻 */
  llmAt?: number
}

const traces = new Map<string, Trace>()
const MAX_TRACES = 2000

function num(value: number): string {
  if (value < 1) return value.toFixed(2)
  if (value < 100) return value.toFixed(1)
  return String(Math.round(value))
}

export function enabled(): boolean {
  return ENABLED
}

// testagent_change - 仅远端 OTLP 通道（经 Observability.layer 上报）
const elog = EffectLogger.create({ service: "testagent.latency" })

/** 生成稳定的短 traceId，便于在日志里肉眼比对 */
export function traceId(key: string): string {
  let id = traces.get(key)?.id
  if (id) return id
  // FNV-1a 32bit，取 8 位十六进制
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  id = (hash >>> 0).toString(16).padStart(8, "0")
  if (traces.size >= MAX_TRACES) {
    const first = traces.keys().next().value
    if (first) traces.delete(first)
  }
  traces.set(key, { id })
  return id
}

function slot(key: string): Trace {
  const id = traceId(key)
  const existing = traces.get(key)
  if (existing) return existing
  const created = { id }
  traces.set(key, created)
  return created
}

/** ② CLI 把 part 写进 store（updatePart / updatePartDelta 调用点） */
export function markCliPart(input: { sessionID: string; messageID: string; partID: string }): void {
  if (!ENABLED) return
  const key = `${input.sessionID}:${input.messageID}:${input.partID}`
  const trace = slot(key)
  trace.cliAt = performance.now()
}

/** ③ 事件入库并广播完成 */
export function markSyncFx(input: {
  sessionID: string
  messageID?: string
  partID?: string
  type: string
}): Effect.Effect<void> {
  if (!ENABLED) return Effect.void
  const key = `${input.sessionID}:${input.messageID ?? ""}:${input.partID ?? ""}`
  const trace = slot(key)
  trace.syncAt = performance.now()
  const elapsed = trace.syncAt - (trace.cliAt ?? trace.syncAt)
  return elog.info("③ 事件入库", {
    traceId: trace.id,
    sessionID: input.sessionID,
    messageID: input.messageID,
    partID: input.partID,
    eventType: input.type,
    durationMs: Math.round(elapsed * 100) / 100,
  })
}

/** ① LLM 首个 token */
export function markLlmFirstTokenFx(input: {
  sessionID: string
  messageID: string
  partID: string
  kind: string
}): Effect.Effect<void> {
  if (!ENABLED) return Effect.void
  const key = `${input.sessionID}:${input.messageID}:${input.partID}`
  const trace = slot(key)
  if (trace.llmAt) return Effect.void
  trace.llmAt = performance.now()
  return elog.info("① LLM首字", {
    traceId: trace.id,
    sessionID: input.sessionID,
    messageID: input.messageID,
    partID: input.partID,
    kind: input.kind,
  })
}

type PartInput = {
  sessionID: string
  messageID: string
  partID: string
  kind: string
  elapsed: number
  size?: number
}

/**
 * ② 记录 CLI 写入耗时。
 *
 * 上报字段：
 *   traceId      链路 ID
 *   partType     part 类型（text / reasoning / tool / delta:text …）
 *   durationMs   本次写入耗时
 *   sinceLlmMs   距 LLM 首字的间隔（仅首个正文增量有值）
 *   size         增量长度（delta 才有）
 */
export function logCliPartFx(input: PartInput): Effect.Effect<void> {
  if (!ENABLED) return Effect.void
  const key = `${input.sessionID}:${input.messageID}:${input.partID}`
  const trace = slot(key)
  // 写入完成后调用，此刻即为 CLI 侧完成时刻
  if (trace.cliAt === undefined) trace.cliAt = performance.now()
  const sinceLlm = trace.llmAt !== undefined ? trace.cliAt - trace.llmAt : undefined

  return elog.info("② CLI写入part", {
    traceId: trace.id,
    sessionID: input.sessionID,
    messageID: input.messageID,
    partID: input.partID,
    partType: input.kind,
    durationMs: Math.round(input.elapsed * 100) / 100,
    sinceLlmMs: sinceLlm === undefined ? undefined : Math.round(sinceLlm * 100) / 100,
    size: input.size,
  })
}

export function traceFor(sessionID: string, messageID: string, partID: string) {
  return slot(`${sessionID}:${messageID}:${partID}`)
}
