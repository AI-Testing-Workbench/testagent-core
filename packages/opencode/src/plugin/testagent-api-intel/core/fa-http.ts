// testagent_change - HTTP client for the FA platform.
// accessToken is the logged-in user token injected via PUT /testagent/user and
// synced to TESTAGENT_USER_TOKEN — the same source testagent-zh reads. It is
// read fresh per request (login may sync after the plugin loaded) and sent as
// a bare Authorization header (no "Bearer " prefix) per fa-api.md. The business
// envelope is { returnCode, body, errorMsg }. The base URL is FA_BASE_URL,
// intentionally blank until the real host is known.

import { type Envelope, fail, ok } from "./errors"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "testagent-api-intel.fa-http" })

const SUCCESS = "SUC0000"
const DEFAULT_BASE = "https://testhub-gateway-dev.paas.cmbchina.cn"

function readToken(): string {
  return process.env["TESTAGENT_USER_TOKEN"] ?? ""
}

export type FaBusinessEnvelope<T> = {
  returnCode?: string
  errorMsg?: string
  body?: T
}

export type FaHttpConfig = {
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export class FaHttp {
  private readonly base: string
  private readonly fetchImpl: typeof fetch

  constructor(cfg: FaHttpConfig = {}) {
    this.base = (cfg.baseUrl ?? process.env["FA_BASE_URL"] ?? DEFAULT_BASE).replace(/\/+$/, "")
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  async get<T>(
    path: string,
    opts: { query?: Record<string, string | undefined>; route: string; signal?: AbortSignal },
  ): Promise<Envelope<T>> {
    // base URL is intentionally left blank until the real FA host is known.
    if (!this.base) {
      return fail("fa", "fa: base URL 未配置", {
        route: opts.route,
        hint: "设置环境变量 FA_BASE_URL 指向 FA 网关后重试",
      })
    }

    const token = readToken()
    if (!token) {
      return fail("fa", "fa: accessToken 未配置", {
        route: opts.route,
        hint: "登录后由testagent 注入 token",
      })
    }

    const url = new URL(`${this.base}${path}`)
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined) continue
        url.searchParams.set(k, v)
      }
    }

    let res: Response
    try {
      res = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: { authorization: token },
        signal: opts.signal,
      })
    } catch (err) {
      // fetch failed 的真实原因在 err.cause（DNS / ECONNREFUSED / TLS 证书 / 超时）
      const msg = err instanceof Error ? err.message : String(err)
      const cause =
        err instanceof Error && err.cause
          ? err.cause instanceof Error
            ? err.cause.message
            : String(err.cause)
          : ""
      const detail = cause ? `${msg} (cause: ${cause})` : msg
      log.warn("network error", { route: opts.route, error: msg, cause: cause || undefined })
      return fail("fa", `fa: 网络错误: ${detail}`, { route: opts.route })
    }

    const text = await res.text()
    let json: FaBusinessEnvelope<unknown> | null = null
    try {
      json = text ? (JSON.parse(text) as FaBusinessEnvelope<unknown>) : null
    } catch {
      return fail("fa", `fa: 非 JSON 响应 (HTTP ${res.status})`, { route: opts.route })
    }
    if (!res.ok) {
      return fail("fa", `fa: HTTP ${res.status}`, { route: opts.route })
    }
    if (!json || typeof json !== "object") {
      return fail("fa", "fa: 响应不是 JSON 对象", { route: opts.route })
    }
    if (json.returnCode !== undefined && json.returnCode !== SUCCESS) {
      const msg = json.errorMsg || `returnCode=${json.returnCode}`
      return fail("fa", `fa: ${msg}`, { route: opts.route })
    }
    return ok("fa", json.body as T, opts.route)
  }
}
