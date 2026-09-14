// testagent_change - Apicol adapter (API 协作平台).
// Implements scan / list / fetch / fetchAll against the four real endpoints
// documented in packages/testflow/docs/design/api.md. FTC/FA are not
// implemented in this stage.

import { ApicolHttp } from "../core/http"
import { type Envelope, type PlatformId, fail, ok } from "../core/errors"
import { type Candidate, matchRef, parseEndpointRef, suggestCandidates } from "../core/match"
import { type EndpointDefinition, parseSwagger } from "../core/swagger"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "testagent-api-intel.apicol" })

const ROUTES = {
  listDeployUnits: "GET /ed/openapi/system/{systemId}/deploy-unit",
  listProjects: "GET /ed/openapi/system/{systemId}/project/page",
  listApis: "POST /ed/openapi/project/user/api/list",
  swagger: "POST /ed/openapi/project/user/swagger",
} as const

const SKIP_API_STATUSES = ["DESIGNING"] as const

const DEFAULT_PAGE_SIZE = 50

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

export type App = {
  appId: string
  appName: string
  description?: string
  extra?: Record<string, unknown>
}

export type ScanInput = {
  systemId?: string
  deployUnit?: string
  keyword?: string
}

export type ListInput = { appId: string }

export type FetchInput = { appId: string; endpointRefs: string[] }

export type FetchAllInput = { appId: string }

export type ScanResult = { apps: App[] }
export type ListResult = { appId: string; endpoints: Endpoint[]; skipped: { count: number; statuses: string[] } }
export type FetchMatched = { ref: string; endpoint: Endpoint; definition: EndpointDefinition }
export type FetchUnmatched = {
  ref: string
  reason: string
  candidates?: Array<{ name: string; method: string; path: string }>
}
export type FetchResult = { matched: FetchMatched[]; unmatched: FetchUnmatched[] }
export type FetchAllResult = {
  appId: string
  endpoints: Endpoint[]
  skipped: { count: number; statuses: string[] }
}

type ApiRow = {
  id?: number
  name?: string
  uri?: string
  protocol?: string
  introduction?: string
  method?: string
  apiStatus?: string
  groupId?: number
  groupIdPath?: string
  groupNamePath?: string
  createBy?: string
  updateBy?: string
  createTime?: string
  updateTime?: string
}

type ProjectRow = {
  projectId?: string
  projectName?: string
  description?: string
  systemId?: string
}

type DeployUnitList = string[]

type ProjectPage = {
  records?: ProjectRow[]
  total?: number
  current?: number
  size?: number
  pages?: number
}

type ApiListBody = ApiRow[]

type SwaggerBody = string

function toEndpoint(row: ApiRow): Endpoint {
  const ep: Endpoint = { name: row.name ?? "", method: row.method ?? "", path: row.uri ?? "" }
  if (row.id !== undefined) ep.apiId = String(row.id)
  if (row.protocol) ep.protocol = row.protocol
  if (row.introduction) ep.description = row.introduction
  if (row.apiStatus) ep.status = row.apiStatus
  ep.extra = {
    groupId: row.groupId,
    groupIdPath: row.groupIdPath,
    groupNamePath: row.groupNamePath,
    createBy: row.createBy,
    updateBy: row.updateBy,
    createTime: row.createTime,
    updateTime: row.updateTime,
  }
  return ep
}

function applyStatusFilter(eps: Endpoint[]): { visible: Endpoint[]; skipped: { count: number; statuses: string[] } } {
  const visible: Endpoint[] = []
  const skippedStatuses = new Set<string>()
  for (const e of eps) {
    if (e.status && (SKIP_API_STATUSES as readonly string[]).includes(e.status)) {
      skippedStatuses.add(e.status)
      continue
    }
    visible.push(e)
  }
  return {
    visible,
    skipped: { count: eps.length - visible.length, statuses: [...skippedStatuses] },
  }
}

export class ApicolAdapter {
  private readonly http: ApicolHttp

  constructor(http?: ApicolHttp) {
    this.http = http ?? new ApicolHttp()
  }

  async scan(input: ScanInput, signal?: AbortSignal): Promise<Envelope<ScanResult>> {
    if (!input.systemId) {
      return fail("apicol", "scan requires systemId for apicol", {
        hint: "传入 systemId 后重试",
      })
    }

    const du = await this.http.get<DeployUnitList>(`/ed/openapi/system/${encodeURIComponent(input.systemId)}/deploy-unit`, {
      query: { keyword: input.keyword },
      route: ROUTES.listDeployUnits,
      signal,
    })
    if (!du.ok) return du as Envelope<ScanResult>

    const units = input.deployUnit ? du.data.filter((u) => u === input.deployUnit) : du.data
    if (units.length === 0) {
      log.warn("no deploy units matched", { systemId: input.systemId, deployUnit: input.deployUnit })
      return ok("apicol" as PlatformId, { apps: [] }, ROUTES.listProjects)
    }

    const apps: App[] = []
    for (const unit of units) {
      const page = await this.http.get<ProjectPage>(
        `/ed/openapi/system/${encodeURIComponent(input.systemId)}/project/page`,
        {
          query: {
            deployUnit: unit,
            keyword: input.keyword,
            pageNum: 1,
            pageSize: DEFAULT_PAGE_SIZE,
          },
          route: ROUTES.listProjects,
          signal,
        },
      )
      if (!page.ok) return page as Envelope<ScanResult>
      for (const row of page.data.records ?? []) {
        if (!row.projectId) continue
        const app: App = {
          appId: String(row.projectId),
          appName: row.projectName ?? "",
          extra: { systemId: input.systemId, deployUnit: unit },
        }
        if (row.description !== undefined) app.description = row.description
        apps.push(app)
      }
    }

    return ok("apicol" as PlatformId, { apps }, ROUTES.listProjects)
  }

  async list(input: ListInput, signal?: AbortSignal): Promise<Envelope<ListResult>> {
    const res = await this.http.post<ApiListBody>("/ed/openapi/project/user/api/list", {
      body: { projectId: input.appId },
      route: ROUTES.listApis,
      signal,
    })
    if (!res.ok) return res as Envelope<ListResult>
    const eps = (res.data ?? []).map(toEndpoint)
    const { visible, skipped } = applyStatusFilter(eps)
    return ok("apicol" as PlatformId, { appId: input.appId, endpoints: visible, skipped }, ROUTES.listApis)
  }

  async fetch(input: FetchInput, signal?: AbortSignal): Promise<Envelope<FetchResult>> {
    const listRes = await this.list({ appId: input.appId }, signal)
    if (!listRes.ok) return listRes as Envelope<FetchResult>
    const candidates: Candidate[] = listRes.data.endpoints.map((e) => {
      const c: Candidate = { name: e.name, method: e.method, path: e.path }
      if (e.apiId !== undefined) c.apiId = parseInt(e.apiId, 10)
      if (e.status) c.status = e.status
      return c
    })

    const sw = await this.http.post<SwaggerBody>("/ed/openapi/project/user/swagger", {
      body: { projectId: input.appId, swaggerVersion: "V30" },
      route: ROUTES.swagger,
      signal,
    })
    if (!sw.ok) return sw as Envelope<FetchResult>

    let parsed: ReturnType<typeof parseSwagger>
    try {
      parsed = parseSwagger(sw.data ?? "")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return fail("apicol", `apicol: swagger 解析失败: ${msg}`, { route: ROUTES.swagger })
    }

    const matched: FetchMatched[] = []
    const unmatched: FetchUnmatched[] = []
    for (const raw of input.endpointRefs) {
      const ref = parseEndpointRef(raw)
      if (!ref) {
        unmatched.push({ ref: raw, reason: "endpointRef 格式不合法" })
        continue
      }
      const hits = matchRef(ref, candidates)
      if (hits.length === 0) {
        const reason =
          candidates.find((c) => c.status && SKIP_API_STATUSES.includes(c.status as (typeof SKIP_API_STATUSES)[number])) &&
          (ref.name || ref.path)
            ? "接口状态为 DESIGNING，已被配置跳过"
            : "未匹配到接口"
        unmatched.push({
          ref: raw,
          reason,
          candidates: suggestCandidates(raw, candidates).map((c) => ({
            name: c.name,
            method: c.method,
            path: c.path,
          })),
        })
        continue
      }
      for (const hit of hits) {
        const opKey = `${hit.method.toUpperCase()} ${hit.path}`
        const def = parsed.operations[opKey] ?? {
          inputSchema: { unresolved: true },
          outputSchema: { unresolved: true },
          errors: [],
        }
        matched.push({
          ref: raw,
          endpoint: {
            name: hit.name,
            method: hit.method,
            path: hit.path,
            ...(hit.status !== undefined ? { status: hit.status } : {}),
            ...(hit.apiId !== undefined ? { apiId: String(hit.apiId) } : {}),
          },
          definition: def,
        })
      }
    }

    return ok("apicol" as PlatformId, { matched, unmatched }, ROUTES.swagger)
  }

  async fetchAll(input: FetchAllInput, signal?: AbortSignal): Promise<Envelope<FetchAllResult>> {
    const listRes = await this.list({ appId: input.appId }, signal)
    if (!listRes.ok) return listRes as Envelope<FetchAllResult>
    return ok(
      "apicol" as PlatformId,
      {
        appId: input.appId,
        endpoints: listRes.data.endpoints,
        skipped: listRes.data.skipped,
      },
      ROUTES.listApis,
    )
  }
}