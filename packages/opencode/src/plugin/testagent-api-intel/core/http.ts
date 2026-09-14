// testagent_change - authenticated HTTP client for Apicol business endpoints.
// Always injects Authorization header with the token from ApicolAuth. Treats
// HTTP 2xx with returnCode !== "SUC0000" as a business error.

import { ApicolAuth } from "./auth"
import type { Envelope, PlatformId } from "./errors"
import { fail, ok } from "./errors"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "testagent-api-intel.http" })

export type ApicolBusinessEnvelope<T> = {
  returnCode?: string
  errorMsg?: unknown
  body?: T
}

export type HttpConfig = {
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export class ApicolHttp {
  private readonly auth: ApicolAuth
  private readonly base: string
  private readonly fetchImpl: typeof fetch

  constructor(cfg: HttpConfig = {}) {
    this.base = (cfg.baseUrl ?? process.env["APICOL_BASE_URL"] ?? "https://apicol-gateway.paas.cmbchina.cn/gw").replace(/\/+$/, "")
    this.auth = new ApicolAuth(cfg)
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  private async authed(
    method: "GET" | "POST",
    path: string,
    init: { body?: unknown; query?: Record<string, string | number | undefined> },
    route: string,
    signal?: AbortSignal,
  ): Promise<Envelope<unknown>> {
    const token = await this.auth.getToken(signal).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn("token fetch failed", { error: msg })
      return null
    })
    if (!token) {
      return fail("apicol", "apicol: 获取 token 失败", {
        route,
        hint: "确认 /ed/openapi/token 可达，且 sapId 已注入用户链路",
      })
    }

    const url = new URL(`${this.base}${path}`)
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v === undefined) continue
        url.searchParams.set(k, String(v))
      }
    }

    const headers: Record<string, string> = { authorization: token }
    let body: string | undefined
    if (init.body !== undefined) {
      headers["content-type"] = "application/json"
      body = JSON.stringify(init.body)
    }

    let res: Response
    try {
      res = await this.fetchImpl(url.toString(), { method, headers, signal, body })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn("network error", { route, error: msg })
      return fail("apicol", `apicol: 网络错误: ${msg}`, { route })
    }

    const text = await res.text()
    let json: ApicolBusinessEnvelope<unknown> | null = null
    try {
      json = text ? (JSON.parse(text) as ApicolBusinessEnvelope<unknown>) : null
    } catch {
      return fail("apicol", `apicol: 非 JSON 响应 (HTTP ${res.status})`, { route })
    }
    if (!res.ok) {
      return fail("apicol", `apicol: HTTP ${res.status}`, { route })
    }
    if (!json || typeof json !== "object") {
      return fail("apicol", "apicol: 响应不是 JSON 对象", { route })
    }
    if (json.returnCode !== undefined && json.returnCode !== "SUC0000") {
      const msg = typeof json.errorMsg === "string" ? json.errorMsg : `returnCode=${json.returnCode}`
      return fail("apicol", `apicol: ${msg}`, { route })
    }
    return ok("apicol" as PlatformId, json.body, route)
  }

  get<T = unknown>(
    path: string,
    opts: { query?: Record<string, string | number | undefined>; route: string; signal?: AbortSignal },
  ): Promise<Envelope<T>> {
    return this.authed("GET", path, { query: opts.query }, opts.route, opts.signal) as Promise<Envelope<T>>
  }

  post<T = unknown>(
    path: string,
    opts: { body?: unknown; route: string; signal?: AbortSignal },
  ): Promise<Envelope<T>> {
    return this.authed("POST", path, { body: opts.body }, opts.route, opts.signal) as Promise<Envelope<T>>
  }
}