// testagent_change - new file
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import type { TextPart } from "@opencode-ai/sdk"
import { existsSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { ServerAuth } from "@/server/auth"
import { GlobalBus } from "@/bus/global"

// 云端判定：与 extension 的 isCloudMode()（kilo-vscode/src/services/cli-backend/cloud-mode.ts，
// 决定「复制 Web UI 链接」按钮是否显示）同一口径——env 或 marker 文件，任一命中即云端。
// serve 进程由扩展派生，继承同一份 env、看到同一个 marker 文件，判定结果必然与按钮一致；
// 独立启动的 CLI 同样靠这两个信号，不额外引入第三种判定。
function isCloudMode(): boolean {
  return process.env["TESTAGENT_CLOUD_MODE"] === "1" || existsSync("/etc/tscode-cloud-mode")
}

// ZH relay 地址：云端由 sandbox-service 注入 ZH_RELAY_URL；本地可用环境变量覆盖（ZH_RELAY_URL 或
// 兼容历史命名 TESTAGENT_ZH_RELAY_URL），未注入时使用内置默认地址。默认地址 base64 编码存储，使用前解码。
const DEFAULT_RELAY_URL_B64 = "aHR0cHM6Ly90ZXN0YWdlbnQtZ2F0ZXdheS5wYWFzdWF0LmNtYmNoaW5hLmNuL3poYW9odQ=="
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

const ASK_TIMEOUT_MS = 0 // 0 = 永不超时，一直轮询
const ANSWER_POLL_MS = 15_000 // relay answer 轮询间隔
// 启动通知：serve 起来后推一条「沙箱启动成功 + Web UI 地址」。登录态（userId/token）由扩展或
// env-vars 系统变量注入，可能晚于插件加载，缺失时按 START_RETRY_MS 重试，最多 START_RETRY_MAX 次。
const START_RETRY_MS = 5_000
const START_RETRY_MAX = 24 // 约 2 分钟
// 进程级去重：插件按目录实例化，多工作区/多实例时启动通知只发一次
let startStarted = false
const pending = new Map<string, Pending>()
let pollLoop: Promise<void> | null = null
// 插件自己注入的回复 id（轮询拿到招乎答案后由插件回复 serve），这些事件不应触发 relay 删除
const pluginReplied = new Set<string>()

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Web UI 远程访问 host：与扩展的「复制 Web UI 链接」按钮
// （kilo-vscode/src/services/cli-backend/share-link.ts）同一口径——
// TESTAGENT_SHARE_HOST 覆盖 → 首个非内网 IPv4 → 127.0.0.1，保证通知里的地址和按钮复制的一致。
function shareHost(): string {
  const override = process.env.TESTAGENT_SHARE_HOST
  if (override) return override
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const info of nets[name] ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address
    }
  }
  return "127.0.0.1"
}

// 日志优先走插件 log 通道（写入服务端日志文件）；插件初始化前回退 console
let serverLog: PluginInput["log"]
function zhLog(level: "info" | "warn" | "error", message: string, data?: unknown) {
  if (serverLog) {
    serverLog(level, message, (data ?? {}) as Record<string, unknown>)
    return
  }
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

export const ZhBridgePlugin: Plugin = async ({ client, directory, serverUrl, log, metric }) => {
  serverLog = log
  metric?.("testagent.zh.startup", 1, { service: "testagent-zh" })
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
    pluginReplied.add(askId)
    const res = await httpPost(url, reply)
    pending.delete(askId)
    zhLog("info", "injected reply", { id: askId, kind: p.kind, reply, url: routedUrl(url), response: res })
  }

  async function rejectAsk(askId: string, kind: Pending["kind"]) {
    const url = kind === "permission" ? `/permission/${askId}/reply` : `/question/${askId}/reject`
    pluginReplied.add(askId)
    const res = await httpPost(url, kind === "permission" ? { reply: "reject" } : undefined)
    zhLog("info", "reject sent", { id: askId, kind, response: res })
  }

  // 本地已答/拒：异步通知 relay 删除对应卡片，无需等待结果
  function fireDelete(askId: string) {
    const url = `${RELAY_URL}/message/testagent/${askId}`
    zhLog("info", "delete request", { id: askId, method: "DELETE", url })
    fetch(url, {
      method: "DELETE",
      headers: relayHeaders(),
    })
      .then((res) => zhLog("info", "delete response", { id: askId, status: res.status }))
      .catch((err) => zhLog("warn", "delete failed", { id: askId, error: String(err) }))
  }

  // 取本轮最终回答正文：从最新一条 assistant 消息往前找，拼出所有正文 text part。
  // /session/:id/message 按 (time_created, id) 升序返回，所以从尾部倒着找即可；
  // 摘要消息（compaction）不算回答，空文本（thinking 分隔符）也跳过，继续往前找。
  // text part 存的就是模型原始输出的 markdown 原文（processor 只做 delta 拼接，不转 HTML），
  // 所以这里原样返回；多段之间用空行拼接，保持 markdown 块级结构。
  async function fetchAnswer(sessionID: string) {
    try {
      const result = await client.session.messages({ path: { id: sessionID }, query: { limit: 50 } })
      const msgs = result.data ?? []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (!msg || msg.info.role !== "assistant") continue
        if (msg.info.summary) continue
        const text = msg.parts
          .filter((p): p is TextPart => p.type === "text" && !p.synthetic && !p.ignored)
          .map((p) => p.text.trim())
          .filter((p) => p.length > 0)
          .join("\n\n")
        if (text) return text
      }
    } catch (err) {
      zhLog("warn", "session answer fetch failed", { sessionID, error: String(err) })
    }
    return ""
  }

  // 任务完成通知：session 空闲且 reason=completed 时推送到招乎（开关激活后生效），异步不阻塞
  function notifyCompletion(sessionID: string) {
    void (async () => {
      let title = ""
      let parentID: string | undefined = undefined
      try {
        const result = await client.session.get({ path: { id: sessionID } })
        title = result.data?.title ?? ""
        parentID = result.data?.parentID
      } catch (err) {
        zhLog("warn", "session title fetch failed", { sessionID, error: String(err) })
      }
      
      // 跳过子 agent（有 parentID）
      if (parentID) {
        zhLog("info", "skip notification for subagent", { 
          sessionID, 
          hasParent: !!parentID 
        })
        return
      }

      // 带上最终回答正文（markdown 原文）：
      // - 云端：新接口 /message/testagent/cloud/notify，请求体只有 userId + content，
      //   content 直接用正文，不加「xxx 任务完成」前缀（云端不需要这层抬头）；
      // - 本地：沿用招乎卡片接口，额外带 sessionId / answer 便于定位会话。
      const answer = await fetchAnswer(sessionID)
      const text = title ? `${title} 任务完成` : "任务完成"
      const cloud = isCloudMode()
      const url = cloud
        ? `${RELAY_URL}/message/testagent/cloud/notify`
        : `${RELAY_URL}/message/testagent/notification/notify`
      const body = cloud
        ? {
            userId: USER_ID(),
            // 正文为空（极端情况：没有 text part）时退回抬头，避免发出空 content 被拒
            content: answer || text,
            sessionId: sessionID,
          }
        : {
            sessionId: sessionID,
            answer,
            content: [
              { type: "title", content: "TestAgent任务通知", style: 1 },
              { type: "content", list: [{ content: text, style: 0 }] },
            ],
            userId: USER_ID(),
          }
      zhLog("info", "completion notify request", {
        sessionID,
        title,
        cloud,
        answerLength: answer.length,
        url,
        body,
      })
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...relayHeaders() },
          body: JSON.stringify(body),
        })
        zhLog("info", "completion notify response", { sessionID, status: res.status })
      } catch (err) {
        zhLog("warn", "completion notify failed", { sessionID, error: String(err) })
      }
    })()
  }

  async function pollOnce(): Promise<boolean> {
    let anyPending = false
    for (const [askId, p] of pending) {
      if (ASK_TIMEOUT_MS > 0 && Date.now() - p.startedAt > ASK_TIMEOUT_MS) {
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

  // Web UI 远程访问地址：与扩展「复制 Web UI 链接」按钮拼出的字符串一致。
  // 端口取 serve 实际监听端口（Server.url）；auth_token 为 base64(username:password)，
  // 与 GET /testagent/server/auth 返回值同源；serve 未设密码（独立 CLI）时不带 auth_token。
  function shareLink() {
    const url = new URL(String(serverUrl))
    const port = url.port || (url.protocol === "https:" ? "443" : "80")
    const host = shareHost()
    const password = process.env["OPENCODE_SERVER_PASSWORD"]
    if (!password) return `http://${host}:${port}/`
    const username = process.env["OPENCODE_SERVER_USERNAME"] ?? "opencode"
    const token = Buffer.from(`${username}:${password}`).toString("base64")
    return `http://${host}:${port}/?auth_token=${encodeURIComponent(token)}`
  }

  // 启动通知：项目/沙箱启动成功后推一条「沙箱启动成功 + Web UI 地址」，
  // 与完成通知相互独立（不受 enabled 开关影响，也不会因为某个 session 才触发）。
  // 复用招乎已有的 /message/testagent/notification/notify 卡片接口（与本地完成通知同一个），
  // 不新增 relay 端点；没有 session，所以卡片只带标题 + 正文，不带 sessionId/answer。
  // 仅云端发送——消息语义就是沙箱就绪，本地启动不需要通知。
  // 重试策略：登录态未就绪 / 401·403 / 网络异常 → 等 START_RETRY_MS 再试；
  // 其它 HTTP 失败直接放弃，避免对 relay 造成无意义轮询。
  function notifyStartup() {
    if (startStarted) return
    startStarted = true
    if (!isCloudMode()) {
      // 本地不发送，但仍打印一次待发送内容，便于核对 dir 取值是否符合预期
      zhLog("info", "startup notify skipped: not cloud mode", {
        directory,
        localUrl: `${RELAY_URL}/message/testagent/tscode/jump?dir=${encodeURIComponent(directory)}`,
        shareLink: shareLink(),
      })
      return
    }
    void (async () => {
      for (let attempt = 1; attempt <= START_RETRY_MAX; attempt++) {
        if (!USER_ID() || !USER_TOKEN()) {
          zhLog("info", "startup notify waiting for login", { attempt })
          await sleep(START_RETRY_MS)
          continue
        }
        const url = `${RELAY_URL}/message/testagent/notification/notify`
        // dir 取插件实例目录（PluginInput.directory）：serve 由扩展以工作区根目录为 cwd 派生，
        // 首个请求的 ?directory= / x-opencode-directory 也由它携带，Session.create 正是把这个值
        // 原样写进 Session.Info.directory，所以它就是 Web UI 深链 /<base64url(dir)> 的那一段。
        // 路径含空格/中文/反斜杠，必须编码后再放进 query。
        const localUrl = `${RELAY_URL}/message/testagent/tscode/jump?dir=${encodeURIComponent(directory)}`
        // shareLink 是函数，必须调用；写成 ${shareLink} 会把函数源码原样拼进 url
        const webLink = shareLink()
        const body = {
          content: [
            { type: "title", content: "沙箱通知", style: 1 },
            {
              type: "content",
              list: [
                { content: `点击浏览器打开\n`, type: [3], link: { url: webLink } },
                { content: `点击本地工作台打开`, type: [3], link: { url: localUrl } },
              ],
            },
          ],
          userId: USER_ID(),
        }
        zhLog("info", "startup notify request", { attempt, url, directory, localUrl, body })
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...relayHeaders() },
            body: JSON.stringify(body),
          })
          const data = await res.json().catch(() => ({}))
          zhLog("info", "startup notify response", { attempt, status: res.status, body: data })
          if (res.ok && data.returnCode === "SUC0000") return
          if (res.status !== 401 && res.status !== 403) return
        } catch (err) {
          zhLog("warn", "startup notify failed", { attempt, error: String(err) })
        }
        await sleep(START_RETRY_MS)
      }
      zhLog("warn", "startup notify gave up", { attempts: START_RETRY_MAX })
    })()
  }

  notifyStartup()

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
        // 本地已答/拒：停止轮询；仅当非插件自身注入的回复时，异步通知 relay 删除对应卡片
        const id = e.properties?.requestID
        if (!id) return
        pending.delete(id)
        if (pluginReplied.delete(id)) return
        fireDelete(id)
      } else if (e.type === "session.status") {
        const status = e.properties?.status
        if (status?.type === "idle" && status.reason === "completed") {
          notifyCompletion(e.properties?.sessionID)
        }
      }
    },
  }
}
