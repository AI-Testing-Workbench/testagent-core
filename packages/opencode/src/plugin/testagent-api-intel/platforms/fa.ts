// testagent_change - FA adapter. FA 提供两个接口，均无应用发现/list 工作流，
// 只暴露 fetch（见 packages/testflow/docs/design/fa-api.md）：
//   1. GET  /testagent-plugin/fa-api-intel — 按名查询接口定义，需 Authorization；
//   2. POST .../test-agent/single_api_info_write_md — 生成接口定义 md 文件的
//      base64 数据流，无鉴权，不同 host。
// accessToken 读环境变量 TESTAGENT_USER_TOKEN（登录后注入），不缓存；
// 查询接口的 base URL 为 FA_BASE_URL。

import { mkdir, writeFile } from "node:fs/promises"
import { Buffer } from "node:buffer"
import * as path from "node:path"
import { FaHttp } from "../core/fa-http"
import { type Envelope, fail, ok } from "../core/errors"
import { type EndpointDefinition } from "../core/swagger"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "testagent-api-intel.fa" })

const PATH = "/testagent-plugin/fa-api-intel"
const ROUTE = `GET ${PATH}`

// 第二个接口：返回接口定义 md 文件的 base64 数据流。无鉴权、不同 host、
// body 为 snake_case，信封为 { status, returnCode, errorMsg, data }。
// 见 packages/testflow/docs/design/fa-api.md 第二节。
const WRITE_MD_URL_DEFAULT = "http://aitest.paas.cmbchina.cn/pluto-prd/external-api/test-agent/single_api_info_write_md"
const WRITE_MD_ROUTE = "POST fa.writeMd"
const SUCCESS = "SUC0000"

export type Endpoint = {
  apiId?: string
  name: string
  method: string
  path: string
  protocol?: string
  description?: string
  status?: string
  extra?: Record<string, unknown>
}

export type FetchInput = {
  testProductNo: string
  testApiName: string
  testAppName: string
}

export type FetchMatched = { ref: string; endpoint: Endpoint; definition: EndpointDefinition }
export type FetchUnmatched = { ref: string; reason: string }
export type FetchResult = { matched: FetchMatched[]; unmatched: FetchUnmatched[] }

// 第二个接口：生成接口定义 md 文件。outputPath 为目录，最终文件名取响应的
// file_name，写到 <outputPath>/<file_name>。
export type WriteMdInput = {
  testProductNo: string
  testApiName: string
  testAppName: string
  outputPath: string
}

export type WriteMdResult = {
  filePath: string
  fileName: string
  bytes: number
}

type WriteMdEnvelope = {
  status?: string
  returnCode?: string
  errorMsg?: string
  data?: { file_content?: string; file_name?: string }
}

type FaApiRow = {
  testApiId?: string
  testApiName?: string
  testApiDefine?: string
  testApiUri?: string
  testApiMethod?: string
  testApiResponse?: string
}

// testApiDefine / testApiResponse are free-form "field -> type name" strings,
// not standard JSON Schema. When they parse to a JSON object we return it as
// the schema; otherwise we carry the raw string so nothing is silently lost.
function toSchema(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return { raw }
  }
}

export class FaAdapter {
  private readonly http: FaHttp
  private readonly fetchImpl: typeof fetch
  private readonly writeMdUrl: string

  constructor(http?: FaHttp, fetchImpl?: typeof fetch, writeMdUrl?: string) {
    this.http = http ?? new FaHttp()
    this.fetchImpl = fetchImpl ?? fetch
    this.writeMdUrl = writeMdUrl ?? WRITE_MD_URL_DEFAULT
  }

  async fetch(input: FetchInput, signal?: AbortSignal): Promise<Envelope<FetchResult>> {
    const ref = `${input.testProductNo}/${input.testApiName}/${input.testAppName}`
    const res = await this.http.get<FaApiRow>(PATH, {
      query: {
        testProductNo: input.testProductNo,
        testApiName: input.testApiName,
        testAppName: input.testAppName,
      },
      route: ROUTE,
      signal,
    })
    if (!res.ok) return res as Envelope<FetchResult>

    const row = res.data
    // body is empty (or lacks testApiId) when no registered api matched.
    if (!row || !row.testApiId) {
      log.warn("no api matched", { ref })
      return ok("fa", { matched: [], unmatched: [{ ref, reason: "未匹配到接口" }] }, ROUTE)
    }

    const endpoint: Endpoint = {
      name: row.testApiName ?? input.testApiName,
      method: row.testApiMethod ?? "",
      path: row.testApiUri ?? "",
      extra: {
        testApiDefine: row.testApiDefine,
        testApiUri: row.testApiUri,
        testApiMethod: row.testApiMethod,
        testApiResponse: row.testApiResponse,
        testApiName: row.testApiName,
      },
    }
    endpoint.apiId = row.testApiId

    const definition: EndpointDefinition = {
      inputSchema: toSchema(row.testApiDefine),
      outputSchema: toSchema(row.testApiResponse),
      errors: [],
    }

    return ok("fa", { matched: [{ ref, endpoint, definition }], unmatched: [] }, ROUTE)
  }

  // 第二个接口：按 product_no/app_name/api_name 取接口定义 md 文件的 base64
  // 数据流，解码后写到 <outputPath>/<file_name>。无鉴权、不同 host、不同信封。
  async writeMd(input: WriteMdInput, signal?: AbortSignal): Promise<Envelope<WriteMdResult>> {
    let res: Response
    try {
      res = await this.fetchImpl(this.writeMdUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          product_no: input.testProductNo,
          app_name: input.testAppName,
          api_name: input.testApiName,
        }),
        signal,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const cause =
        err instanceof Error && err.cause
          ? err.cause instanceof Error
            ? err.cause.message
            : String(err.cause)
          : ""
      const detail = cause ? `${msg} (cause: ${cause})` : msg
      log.warn("writeMd network error", { error: msg, cause: cause || undefined })
      return fail("fa", `fa: 网络错误: ${detail}`, { route: WRITE_MD_ROUTE })
    }

    const text = await res.text()
    let json: WriteMdEnvelope | null = null
    try {
      json = text ? (JSON.parse(text) as WriteMdEnvelope) : null
    } catch {
      return fail("fa", `fa: 非 JSON 响应 (HTTP ${res.status})`, { route: WRITE_MD_ROUTE })
    }
    if (!res.ok) {
      return fail("fa", `fa: HTTP ${res.status}`, { route: WRITE_MD_ROUTE })
    }
    if (!json || typeof json !== "object") {
      return fail("fa", "fa: 响应不是 JSON 对象", { route: WRITE_MD_ROUTE })
    }
    if (json.returnCode !== undefined && json.returnCode !== SUCCESS) {
      const msg = json.errorMsg || `returnCode=${json.returnCode}`
      return fail("fa", `fa: ${msg}`, { route: WRITE_MD_ROUTE })
    }

    const data = json.data
    const fileContent = data?.file_content
    const fileName = data?.file_name
    if (!fileContent || !fileName) {
      return fail("fa", "fa: 响应缺少 file_content/file_name", { route: WRITE_MD_ROUTE })
    }

    let buf: Buffer
    try {
      buf = Buffer.from(fileContent, "base64")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return fail("fa", `fa: base64 解码失败: ${msg}`, { route: WRITE_MD_ROUTE })
    }

    const filePath = path.join(input.outputPath, fileName)
    try {
      await mkdir(input.outputPath, { recursive: true })
      await writeFile(filePath, buf)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return fail("fa", `fa: 写文件失败: ${msg}`, {
        route: WRITE_MD_ROUTE,
        hint: `确认目录可写: ${input.outputPath}`,
      })
    }

    return ok("fa", { filePath, fileName, bytes: buf.length }, WRITE_MD_ROUTE)
  }
}
