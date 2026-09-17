// testagent_change - FA adapter. FA exposes a single "query by name" lookup
// (GET /api/v1/test-api-module/custom-test-api-by-name) with no app-discovery
// or list workflow, so only the fetch action is meaningful for it. accessToken
// shares apicol's token source; the business base URL is FA_BASE_URL.
// See packages/testflow/docs/design/fa-api.md.

import { FaHttp } from "../core/fa-http"
import { type Envelope, ok } from "../core/errors"
import { type EndpointDefinition } from "../core/swagger"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "testagent-api-intel.fa" })

const PATH = "/testagent-plugin/fa-api-intel"
const ROUTE = `GET ${PATH}`

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

  constructor(http?: FaHttp) {
    this.http = http ?? new FaHttp()
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
}
