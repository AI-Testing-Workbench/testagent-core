// testagent_change - apicol token provider. Reads sapId from the existing user
// chain and exchanges it for a token via the Apicol token endpoint. No extra
// headers on the token request itself; the result is reused as `Authorization`
// on subsequent business calls (handled in core/http.ts).

import { User } from "@/testagent/user"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "testagent-api-intel.auth" })

const DEFAULT_BASE = "https://apicol-gateway.paas.cmbchina.cn/gw"
const TOKEN_PATH = "/ed/openapi/token"

export type TokenResponse = {
  returnCode?: string
  errorMsg?: unknown
  body?: { token?: string }
}

export type ApicolAuthConfig = {
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export class ApicolAuth {
  private readonly base: string
  private readonly fetchImpl: typeof fetch

  constructor(cfg: ApicolAuthConfig = {}) {
    this.base = (cfg.baseUrl ?? process.env["APICOL_BASE_URL"] ?? DEFAULT_BASE).replace(/\/+$/, "")
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  async getToken(signal?: AbortSignal): Promise<string> {
    const user = User.get()
    const sapId = user.sapId
    if (!sapId) {
      throw new Error(
        "apicol: sapId 未配置，请先通过 /testagent/user 或 TESTAGENT_SAP_ID 注入用户信息",
      )
    }

    const url = new URL(`${this.base}${TOKEN_PATH}`)
    url.searchParams.set("sapId", sapId)

    const res = await this.fetchImpl(url.toString(), { method: "GET", signal })
    const text = await res.text()
    let json: TokenResponse | null = null
    try {
      json = text ? (JSON.parse(text) as TokenResponse) : null
    } catch {
      throw new Error(`apicol token: 非 JSON 响应 (HTTP ${res.status})`)
    }
    if (!res.ok) {
      throw new Error(`apicol token: HTTP ${res.status}`)
    }
    if (!json || typeof json !== "object") {
      throw new Error("apicol token: 响应不是 JSON 对象")
    }
    if (json.returnCode !== "SUC0000") {
      throw new Error(`apicol token: returnCode=${json.returnCode ?? "?"}`)
    }
    const token = json.body?.token
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("apicol token: 响应缺少 body.token")
    }
    log.debug("apicol token acquired", { length: token.length })
    return token
  }
}