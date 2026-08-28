// testagent_change - new file
import type { Plugin } from "@opencode-ai/plugin"
import { ServerAuth } from "@/server/auth"
import { GlobalBus } from "@/bus/global"

// ZH relay 地址：云端由 sandbox-service 注入 ZH_RELAY_URL；本地可用环境变量覆盖（ZH_RELAY_URL 或
// 兼容历史命名 TESTAGENT_ZH_RELAY_URL），未注入时使用内置默认地址。默认地址 base64 编码存储，使用前解码。
const DEFAULT_RELAY_URL_B64 = "aHR0cHM6Ly90ZXN0YWdlbnQtemgtcm9ib3QucGFhc3VhdC5jbWJjaGluYS5jbg=="
const RELAY_URL =
  process.env.ZH_RELAY_URL ?? process.env.TESTAGENT_ZH_RELAY_URL ?? atob(DEFAULT_RELAY_URL_B64)
// 登录态（强制登录后由 env-vars 系统变量注入）：userId/token 每次请求实时读取，避免启动时未同步
const USER_ID = () => process.env.TESTAGENT_USER_ID ?? ""
const USER_TOKEN = () => process.env.TESTAGENT_USER_TOKEN ?? ""
// 激活源相互独立：TESTAGENT_ZH_ANSWER_ENABLED=1 仅启动时生效（扩展/云端注入）；运行中由按钮热切换
let enabled = process.env.TESTAGENT_ZH_ANSWER_ENABLED === "1"

type Pending = {
  kind: "permission" | "question"
  startedAt: number
}

const ASK_TIMEOUT_MS = 30 * 60 * 1000
const ANSWER_POLL_MS = 3_000 // relay answer 轮询间隔（感知延迟 ≈ 该值）
const pending = new Map<string, Pending>()
let pollLoop: Promise<void> | null = null

// 诊断日志直接打到 console（扩展经 stdout/stderr 转发到 TestAgent 输出通道）
function zhLog(level: "info" | "warn" | "error", message: string, data?: unknown) {
  const line = `[TESTAGENT_ZH] ${message}${data !== undefined ? ` ${JSON.stringify(data)}` : ""}`
  if (level === "warn") console.warn(line)
  else if (level === "error") console.error(line)
  else console.log(line)
}

// 进程级全局开关监听（跨实例）：按钮经 GlobalBus 广播。
// /testagent/* 是 root 路由，无 per-instance 目录上下文，事件必须走 GlobalBus 而非 per-directory Bus。
GlobalBus.on("event", (event) => {
  const payload = event.payload as { type?: string; properties?: { enabled?: boolean } } | undefined
  if (!payload || typeof payload !== "object") return
  if (payload.type !== "zh.answer.toggled") return
  enabled = payload.properties?.enabled === true
  zhLog("info", "answer toggle (global)", { enabled })
  if (!enabled) pending.clear()
})

export const ZhBridgePlugin: Plugin = async ({ client, directory, serverUrl, log }) => {
  // 仅要求 relay 地址已配置；登录态 token 可能晚于插件加载才同步（连接后 PUT /testagent/user），
  // token 缺失时 sendAsk 鉴权失败会自动回退本地确认。
  if (!RELAY_URL) {
    zhLog("warn", "disabled: ZH_RELAY_URL not set")
    log("debug", "testagent-zh disabled: ZH_RELAY_URL not set")
    return {}
  }
  zhLog("info", "plugin loaded", { relay: RELAY_URL, token: USER_TOKEN() ? "present" : "missing", enabled, directory })

  function relayHeaders() {
    return { Authorization: `Bearer ${USER_TOKEN()}` }
  }

  // 发送交互卡片（relay 接口 1/2）；失败抛错由调用方按"不阻塞本地确认"处理
  async function sendAsk(askId: string, kind: Pending["kind"], payload: any) {
    const url =
      kind === "permission"
        ? `${RELAY_URL}/message/testagent/permission/request`
        : `${RELAY_URL}/message/testagent/question/send`
    const body =
      kind === "permission"
        ? {
            id: askId,
            sessionId: payload.sessionID,
            permission: payload.permission,
            patterns: payload.patterns,
            always: payload.always,
            userId: USER_ID(),
          }
        : {
            id: askId,
            sessionId: payload.sessionID,
            userId: USER_ID(),
            questions: payload.questions.map((q: any) => ({
              header: q.header,
              multiple: Boolean(q.multiple),
              custom: Boolean(q.custom ?? true),
              options: q.options.map((o: any) => ({ label: o.label, description: o.description })),
              question: q.question,
            })),
          }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...relayHeaders() },
      body: JSON.stringify(body),
    })
    zhLog("info", "send request", { id: askId, kind, method: "POST", url, body }) // testagent_change - 发出请求日志
    const data = await res.json().catch(() => ({}))
    zhLog("info", "send response", { id: askId, kind, status: res.status, body: data })
    if (!res.ok || data.returnCode !== "SUC0000") {
      throw new Error(`relay send failed: ${res.status}`)
    }
    zhLog("info", "send ok", { id: askId, kind, url })
  }

  // 轮询答案（relay 接口 3）→ 转换为 serve 回复格式；未答复返回 null；reject 返回 "reject"
  async function pollAnswer(askId: string, kind: Pending["kind"]): Promise<unknown | null> {
    const url = `${RELAY_URL}/message/testagent/answer?id=${askId}`
    zhLog("info", "poll request", { id: askId, kind, method: "GET", url }) // testagent_change - 发出请求日志
    const res = await fetch(url, { headers: relayHeaders() })
    const data = await res.json()
    zhLog("info", "poll response", { id: askId, status: res.status, body: data })
    if (data.returnCode !== "SUC0000") return null
    const raw = data.body?.answer
    if (!raw) return null
    zhLog("info", "answer received", { id: askId, kind, raw })
    if (kind === "permission") {
      const answer = JSON.parse(raw)
      return answer.action === "reject" ? "reject" : { reply: answer.action }
    }
    const answers = JSON.parse(raw) // 与问题顺序一致的字符串数组
    return { answers: answers.map((elem: string) => parseAnswerElem(elem)) }
  }

  function parseAnswerElem(elem: string): string[] {
    if (!elem) return []
    try {
      const parsed = JSON.parse(elem)
      return Array.isArray(parsed) ? parsed : [String(parsed)]
    } catch {
      return [elem]
    }
  }

  // v1 SDK 未封装 reply/reject 端点（client.gen.ts request 支持任意 URL）。
  // 注意：不能用 client 的内置 fetch（Server.Default().app.fetch 走的是另一套 memoize 的 service 树，
  // Question.Service 与 HTTP 监听器树不是同一个，回复会打到空的 pending 上）。
  // 必须走 serverUrl 的 HTTP 监听器（与扩展 webview 回复同路径），并带 Basic auth 头。
  const baseUrl = String(serverUrl).replace(/\/$/, "")
  // 与 plugin/index.ts 创建 client 时同源的 Basic auth 头
  const clientHeaders: Record<string, string> = { ...(ServerAuth.headers() ?? {}) }

  function routedUrl(path: string) {
    const params = new URLSearchParams()
    if (directory) params.set("directory", directory)
    return params.size > 0 ? `${path}?${params.toString()}` : path
  }

  async function httpPost(path: string, body?: unknown) {
    const fullUrl = `${baseUrl}${routedUrl(path)}`
    zhLog("info", "reply request", { method: "POST", url: fullUrl, body }) // testagent_change - 发出请求日志
    const res = await fetch(fullUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...clientHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  }

  async function injectReply(askId: string, reply: unknown) {
    const p = pending.get(askId)
    if (!p) return
    const url = p.kind === "permission" ? `/permission/${askId}/reply` : `/question/${askId}/reply`
    const res = await httpPost(url, reply)
    pending.delete(askId)
    zhLog("info", "injected reply", { id: askId, kind: p.kind, reply, url: routedUrl(url), response: res })
  }

  async function rejectAsk(askId: string, kind: Pending["kind"]) {
    const url = kind === "permission" ? `/permission/${askId}/reply` : `/question/${askId}/reject`
    const res = await httpPost(url, kind === "permission" ? { reply: "reject" } : undefined)
    zhLog("info", "reject sent", { id: askId, kind, response: res })
  }

  async function pollOnce(): Promise<boolean> {
    let anyPending = false
    for (const [askId, p] of pending) {
      if (Date.now() - p.startedAt > ASK_TIMEOUT_MS) {
        // 超时：question 拒绝 / permission 拒绝，解除 serve 侧阻塞
        pending.delete(askId)
        try {
          await rejectAsk(askId, p.kind)
        } catch (err) {
          zhLog("warn", "timeout reject failed", { id: askId, error: String(err) })
        }
        continue
      }
      anyPending = true
      try {
        const reply = await pollAnswer(askId, p.kind)
        if (reply === null) continue
        if (reply === "reject") {
          pending.delete(askId)
          await rejectAsk(askId, p.kind)
        } else {
          await injectReply(askId, reply)
        }
      } catch (err) {
        // 网络抖动忽略，下轮续询
        zhLog("error", "poll iteration failed", { id: askId, error: String(err) })
      }
    }
    return anyPending
  }

  function ensurePolling() {
    if (pollLoop) return
    pollLoop = (async () => {
      try {
        while (pending.size > 0) {
          const again = await pollOnce()
          if (!again) break
          await new Promise((resolve) => setTimeout(resolve, ANSWER_POLL_MS))
        }
      } catch (err) {
        zhLog("warn", "poll loop exited", { error: String(err) })
      } finally {
        pollLoop = null
      }
    })()
  }

  return {
    async event({ event }) {
      const e = event as { type?: string; properties?: any }
      if (!e.type) return
      if (e.type === "zh.answer.toggled") {
        enabled = e.properties?.enabled === true
        zhLog("info", "answer toggle", { enabled })
        log("info", "testagent-zh answer toggle", { enabled })
        if (!enabled) pending.clear()
        return
      }
      if (!enabled) {
        // 开关关闭时仍提示 ask 到达，便于判断"功能未生效"是开关问题还是没触发 ask
        if (e.type === "permission.asked" || e.type === "question.asked") {
          zhLog("warn", "ask skipped (disabled)", { id: e.properties?.id, type: e.type })
        }
        return
      }
      if (e.type === "permission.asked" || e.type === "question.asked") {
        const id = e.properties?.id
        if (!id) return
        const kind = e.type === "permission.asked" ? "permission" : "question"
        pending.set(id, { kind, startedAt: Date.now() })
        try {
          await sendAsk(id, kind, e.properties)
        } catch (err) {
          zhLog("error", "send failed", { id, kind, error: String(err) })
          pending.delete(id) // 发送失败不阻塞：任务按原样在 tscode 内等确认
        }
        ensurePolling()
      } else if (
        e.type === "permission.replied" ||
        e.type === "question.replied" ||
        e.type === "question.rejected"
      ) {
        // 本地已答/拒：停止轮询（relay 侧按自身 TTL 清理，无需弃单接口）
        if (e.properties?.requestID) pending.delete(e.properties.requestID)
      }
    },
  }
}
