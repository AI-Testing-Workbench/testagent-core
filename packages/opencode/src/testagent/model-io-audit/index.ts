import { Global } from "@opencode-ai/core/global"
import { mkdir, appendFile } from "node:fs/promises"
import path from "node:path"
import { errorData } from "@/util/error"

const secretKeys = [
  "authorization",
  "cookie",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "password",
  "secret",
  "token",
  "private_key",
]

let queue = Promise.resolve()

export type Event = Record<string, unknown> & {
  event: string
}

export function record(event: Event) {
  if (!enabled()) return
  queue = queue.then(() => write(event)).catch(() => {})
}

export function error(error: unknown) {
  return safeValue(errorData(error))
}

function enabled() {
  const value = process.env.TESTAGENT_MODEL_IO_AUDIT_ENABLED
  return value === undefined || !["0", "false", "off", "no"].includes(value.toLowerCase())
}

async function write(event: Event) {
  const file = process.env.TESTAGENT_MODEL_IO_AUDIT_LOG_PATH ?? path.join(Global.Path.log, "model-io-audit.jsonl")
  const payload = safeObject(event)
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(
    file,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      time: Date.now(),
      pid: process.pid,
      ...payload,
    }) + "\n",
  )
  await appendFile(textLogPath(file), format(payload) + "\n")
}

function textLogPath(file: string) {
  return file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length) + ".log" : file + ".log"
}

function format(event: Record<string, unknown>) {
  if (event.event === "model.response.summary") return formatModelResponse(event)
  if (event.event === "tool.call.summary") return formatToolCall(event)
  return [`[${event.event}]`, JSON.stringify(event, null, 2)].join("\n")
}

function formatModelResponse(event: Record<string, unknown>) {
  const output = objectValue(event.output)
  const tools = objectValue(event.tools)
  const stream = objectValue(event.stream)
  const issues = Array.isArray(event.issues) ? event.issues : []
  return [
    "================================================================================",
    `[MODEL RESPONSE] ${event.providerID}/${event.modelID}`,
    `session=${event.sessionID} message=${event.messageID} agent=${event.agent}`,
    `durationMs=${event.durationMs} completed=${event.completed} finish=${JSON.stringify(event.finishReasons ?? [])}`,
    issues.length ? `[ISSUES] ${issues.join(" | ")}` : "[ISSUES] none",
    "",
    "[OUTPUT]",
    String(output.text ?? ""),
    "",
    "[REASONING]",
    String(output.reasoning ?? ""),
    "",
    "[TOOLS]",
    JSON.stringify(tools, null, 2),
    "",
    "[STREAM]",
    JSON.stringify(stream, null, 2),
    "================================================================================",
  ].join("\n")
}

function formatToolCall(event: Record<string, unknown>) {
  return [
    "--------------------------------------------------------------------------------",
    `[TOOL] ${event.toolName} status=${event.status}`,
    `session=${event.sessionID} message=${event.messageID} call=${event.toolCallID ?? ""}`,
    event.issue ? `[ISSUE] ${event.issue}` : "[ISSUE] none",
    "",
    "[INPUT]",
    JSON.stringify(event.input ?? null, null, 2),
    "",
    "[OUTPUT]",
    typeof event.output === "string" ? event.output : JSON.stringify(event.output ?? null, null, 2),
    "",
    "[ERROR]",
    JSON.stringify(event.error ?? null, null, 2),
    "--------------------------------------------------------------------------------",
  ].join("\n")
}

function objectValue(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function safeObject(value: Record<string, unknown>) {
  const safe = safeValue(value)
  return typeof safe === "object" && safe !== null && !Array.isArray(safe) ? (safe as Record<string, unknown>) : value
}

function safeValue(value: unknown): unknown {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === "string") return compact(value)
  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "bigint") return value.toString()
  if (Array.isArray(value)) return value.map(safeValue)
  if (value instanceof Error) return error(value)
  if (typeof value !== "object") return String(value)

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, shouldRedact(key) ? "[REDACTED]" : safeValue(item)]),
  )
}

function shouldRedact(key: string) {
  const lower = key.toLowerCase()
  return secretKeys.some((item) => lower.includes(item))
}

function compact(value: string) {
  const limit = Number.parseInt(process.env.TESTAGENT_MODEL_IO_AUDIT_PREVIEW_CHARS ?? "4000", 10)
  if (!Number.isFinite(limit) || limit <= 0) return value
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}...[truncated ${value.length - limit} chars]`
}

export * as ModelIOAudit from "./index"