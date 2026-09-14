// testagent_change - local mock for the apicol (API 协作平台) backend.
// Exposes:
//   GET  /ed/openapi/token?sapId=...           -> { returnCode, body:{ token } }
//   GET  /ed/openapi/system/{systemId}/deploy-unit?keyword=
//   GET  /ed/openapi/system/{systemId}/project/page?deployUnit&keyword&pageNum&pageSize
//   POST /ed/openapi/project/user/api/list     body { projectId }
//   POST /ed/openapi/project/user/swagger      body { projectId, swaggerVersion }
// Usage:
//   bun script/apicol-mock-server.ts            (default port 9999, set PORT to change)

import type { IncomingMessage, ServerResponse } from "node:http"

const PORT = Number(process.env.PORT ?? 9999)
const HOST = process.env.HOST ?? "127.0.0.1"

function reply<T>(res: ServerResponse, status: number, body: T) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

function suc<T>(res: ServerResponse, body: T) {
  reply(res, 200, { returnCode: "SUC0000", body })
}

function err(res: ServerResponse, code: string, msg: string, status = 200) {
  reply(res, status, { returnCode: code, errorMsg: msg })
}

function urlPath(url: string): string {
  return url.split("?")[0] ?? url
}

function queryParams(url: string): Record<string, string> {
  const idx = url.indexOf("?")
  if (idx < 0) return {}
  const out: Record<string, string> = {}
  for (const part of url.slice(idx + 1).split("&")) {
    if (!part) continue
    const [k, v] = part.split("=")
    if (!k) continue
    out[decodeURIComponent(k)] = decodeURIComponent(v ?? "")
  }
  return out
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = ""
    req.setEncoding("utf-8")
    req.on("data", (chunk: string) => (buf += chunk))
    req.on("end", () => {
      if (!buf) return resolve({})
      try {
        resolve(JSON.parse(buf))
      } catch (e) {
        reject(e)
      }
    })
    req.on("error", reject)
  })
}

const deployUnits = ["test-unit-a", "test-unit-b"]
const projects = [
  { projectId: "1279", projectName: "demo-project", description: "演示项目" },
  { projectId: "1280", projectName: "demo-orders", description: "订单项目" },
]
const apiList = [
  {
    id: 65025,
    name: "users_create",
    uri: "/api/users",
    protocol: "HTTP",
    introduction: "创建用户",
    method: "POST",
    apiStatus: "DEVELOPING",
    groupId: 12800,
    groupIdPath: "12800",
    groupNamePath: "/全部接口",
    createBy: "80249496",
    updateBy: "80249496",
    createTime: "2025-12-02T09:50:28.000+00:00",
    updateTime: "2025-12-02T09:50:28.000+00:00",
  },
  {
    id: 65026,
    name: "users_get",
    uri: "/api/users/{id}",
    protocol: "HTTP",
    introduction: "获取用户",
    method: "GET",
    apiStatus: "DEVELOPING",
    groupId: 12800,
    groupIdPath: "12800",
    groupNamePath: "/全部接口",
    createBy: "80249496",
    updateBy: "80249496",
    createTime: "2025-12-02T09:50:28.000+00:00",
    updateTime: "2025-12-02T09:50:28.000+00:00",
  },
  {
    id: 65027,
    name: "users_design",
    uri: "/api/users/design",
    protocol: "HTTP",
    introduction: "设计中（应被过滤）",
    method: "GET",
    apiStatus: "DESIGNING",
    groupId: 12800,
    groupIdPath: "12800",
    groupNamePath: "/全部接口",
    createBy: "80249496",
    updateBy: "80249496",
    createTime: "2025-12-02T09:50:28.000+00:00",
    updateTime: "2025-12-02T09:50:28.000+00:00",
  },
]

const swaggerText = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "demo", version: "1.0.0" },
  paths: {
    "/api/users": {
      post: {
        parameters: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  email: { type: "string", format: "email" },
                },
                required: ["name", "email"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    email: { type: "string" },
                  },
                },
              },
            },
          },
          "401": { description: "缺少或无效的访问令牌" },
          "500": { description: "服务器错误" },
        },
      },
    },
    "/api/users/{id}": {
      get: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "ok" },
          "404": { description: "用户不存在" },
        },
      },
    },
  },
})

async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = req.url ?? "/"
  const method = req.method ?? "GET"
  const path = urlPath(url)
  const params = queryParams(url)

  console.log(`[mock] ${method} ${url}`)

  if (method === "GET" && path === "/ed/openapi/token") {
    const sapId = params["sapId"]
    if (!sapId) return err(res, "ERR_NO_SAPID", "sapId missing", 400)
    return suc(res, { token: `t-${sapId}-${Date.now().toString(36)}` })
  }

  const deployUnitMatch = path.match(/^\/ed\/openapi\/system\/([^/]+)\/deploy-unit$/)
  if (method === "GET" && deployUnitMatch) {
    const unit = params["deployUnit"]
    const list = unit ? deployUnits.filter((u) => u === unit) : deployUnits
    return suc(res, list)
  }

  const projectPageMatch = path.match(/^\/ed\/openapi\/system\/([^/]+)\/project\/page$/)
  if (method === "GET" && projectPageMatch) {
    return suc(res, {
      records: projects.map((p) => ({ ...p, systemId: projectPageMatch[1] })),
      total: projects.length,
      current: 1,
      size: 50,
      pages: 1,
    })
  }

  if (method === "POST" && path === "/ed/openapi/project/user/api/list") {
    const body = (await readJson(req)) as { projectId?: string | number }
    if (!body?.projectId) return err(res, "ERR_NO_PROJECT", "projectId missing")
    return suc(res, apiList)
  }

  if (method === "POST" && path === "/ed/openapi/project/user/swagger") {
    return suc(res, swaggerText)
  }

  return reply(res, 404, { returnCode: "ERR_404", errorMsg: `unknown route ${method} ${path}` })
}

import { createServer } from "node:http"
const httpServer = createServer((req, res) => {
  handler(req, res).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e)
    err(res, "ERR_INTERNAL", msg, 500)
  })
})
httpServer.listen(PORT, HOST, () => {
  console.log(`[mock] apicol mock listening on http://${HOST}:${PORT}`)
  console.log(`[mock] try:`)
  console.log(`  curl 'http://${HOST}:${PORT}/ed/openapi/token?sapId=80249496'`)
  console.log(`  curl 'http://${HOST}:${PORT}/ed/openapi/system/LT37.01/deploy-unit'`)
})