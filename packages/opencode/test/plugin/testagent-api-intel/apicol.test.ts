import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ApicolAdapter } from "@/plugin/testagent-api-intel/platforms/apicol"
import { ApicolHttp } from "@/plugin/testagent-api-intel/core/http"

const ORIGINAL_USER = await import("@/testagent/user")
const ORIGINAL_PROCESS_ENV = { ...process.env }

function setSapId(sapId: string | undefined) {
  if (sapId === undefined) {
    ORIGINAL_USER.User.set({} as any)
  } else {
    ORIGINAL_USER.User.set({ userId: "u-test", sapId } as any)
  }
}

function clearSapId() {
  setSapId(undefined)
}

type Router = (url: string, init: RequestInit) => Response | Promise<Response>

function router(handler: Router): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString()
    return handler(url, init)
  }) as unknown as typeof fetch
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("ApicolAdapter", () => {
  beforeEach(() => {
    clearSapId()
    setSapId("u1")
    process.env["APICOL_BASE_URL"] = "https://apicol.test"
  })

  afterEach(() => {
    clearSapId()
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIGINAL_PROCESS_ENV)) delete process.env[k]
    }
    for (const [k, v] of Object.entries(ORIGINAL_PROCESS_ENV)) {
      if (v === undefined) continue
      process.env[k] = v
    }
  })

  const tokenJson = () =>
    json({ returnCode: "SUC0000", body: { token: "t-token" } }, 200)

  test("scan flattens deploy units into apps", async () => {
    const calls: string[] = []
    const fetchImpl = router((url, init) => {
      calls.push(`${init.method} ${url}`)
      if (url.includes("/ed/openapi/token")) return tokenJson()
      if (url.includes("/deploy-unit")) {
        return json({ returnCode: "SUC0000", body: ["unit-a", "unit-b"] })
      }
      if (url.includes("/project/page")) {
        return json({ returnCode: "SUC0000", body: { records: [{ projectId: "1279", projectName: "demo" }] } })
      }
      return json({ returnCode: "ERR" }, 500)
    })

    const adapter = new ApicolAdapter(new ApicolHttp({ baseUrl: "https://apicol.test", fetchImpl }))
    const out = await adapter.scan({ systemId: "LT37.01", keyword: "demo" })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data.apps).toHaveLength(2)
    expect(out.data.apps[0]).toMatchObject({ appId: "1279", appName: "demo" })
    expect(calls.some((c) => c.includes("/deploy-unit"))).toBe(true)
    expect(calls.filter((c) => c.includes("/project/page")).length).toBe(2)
  })

  test("list filters DESIGNING into skipped", async () => {
    const fetchImpl = router((url, init) => {
      if (url.includes("/ed/openapi/token")) return tokenJson()
      if (url.endsWith("/api/list") && init.method === "POST") {
        return json({
          returnCode: "SUC0000",
          body: [
            { id: 1, name: "users_create", method: "POST", uri: "/api/users", introduction: "x", apiStatus: "DEVELOPING" },
            { id: 2, name: "users_design", method: "GET", uri: "/api/users/design", introduction: "d", apiStatus: "DESIGNING" },
          ],
        })
      }
      return json({ returnCode: "ERR" }, 500)
    })
    const Http = ApicolHttp
    const adapter = new ApicolAdapter(new Http({ baseUrl: "https://apicol.test", fetchImpl }))
    const out = await adapter.list({ appId: "1279" })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data.endpoints.map((e) => e.name)).toEqual(["users_create"])
    expect(out.data.skipped).toEqual({ count: 1, statuses: ["DESIGNING"] })
  })

  test("fetch returns matched and unmatched with candidates", async () => {
    const swagger = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/api/users": {
          post: {
            parameters: [{ name: "name", in: "body", required: true, schema: { type: "string" } }],
            responses: {
              "200": { description: "ok", content: { "application/json": { schema: { type: "object" } } } },
              "401": { description: "auth" },
            },
          },
        },
        "/api/users/{id}": {
          get: {
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    })

    const fetchImpl = router((url, init) => {
      if (url.includes("/ed/openapi/token")) return tokenJson()
      if (url.endsWith("/api/list") && init.method === "POST") {
        return json({
          returnCode: "SUC0000",
          body: [
            { id: 1, name: "users_create", method: "POST", uri: "/api/users", apiStatus: "DEVELOPING" },
            { id: 2, name: "users_get", method: "GET", uri: "/api/users/{id}", apiStatus: "DEVELOPING" },
          ],
        })
      }
      if (url.endsWith("/swagger") && init.method === "POST") {
        return json({ returnCode: "SUC0000", body: swagger })
      }
      return json({ returnCode: "ERR" }, 500)
    })
    const Http = ApicolHttp
    const adapter = new ApicolAdapter(new Http({ baseUrl: "https://apicol.test", fetchImpl }))

    const out = await adapter.fetch({
      appId: "1279",
      endpointRefs: ["users_create", "POST /api/users", "users_typo"],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const matched = out.data.matched
    expect(matched.length).toBeGreaterThanOrEqual(2)
    expect(matched.some((m) => m.endpoint.name === "users_create")).toBe(true)
    const unmatched = out.data.unmatched
    expect(unmatched).toHaveLength(1)
    expect(unmatched[0].ref).toBe("users_typo")
    expect(unmatched[0].candidates?.length).toBeGreaterThan(0)
  })

  test("fetchAll returns endpoint catalog without definitions", async () => {
    const fetchImpl = router((url, init) => {
      if (url.includes("/ed/openapi/token")) return tokenJson()
      if (url.endsWith("/api/list") && init.method === "POST") {
        return json({
          returnCode: "SUC0000",
          body: [
            { id: 1, name: "users_create", method: "POST", uri: "/api/users", apiStatus: "DEVELOPING" },
            { id: 2, name: "users_design", method: "GET", uri: "/api/users/design", apiStatus: "DESIGNING" },
          ],
        })
      }
      return json({ returnCode: "ERR" }, 500)
    })
    const Http = ApicolHttp
    const adapter = new ApicolAdapter(new Http({ baseUrl: "https://apicol.test", fetchImpl }))

    const out = await adapter.fetchAll({ appId: "1279" })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data.endpoints.map((e) => e.name)).toEqual(["users_create"])
    expect(out.data.skipped).toEqual({ count: 1, statuses: ["DESIGNING"] })
  })

  test("business failures return envelope error, not exception", async () => {
    const fetchImpl = router((url) => {
      if (url.includes("/ed/openapi/token")) return tokenJson()
      return json({ returnCode: "ERR007", errorMsg: "forbidden" }, 200)
    })
    const Http = ApicolHttp
    const adapter = new ApicolAdapter(new Http({ baseUrl: "https://apicol.test", fetchImpl }))
    const out = await adapter.list({ appId: "1279" })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain("forbidden")
    expect(out.platform).toBe("apicol")
  })

  test("missing sapId returns friendly error from http layer", async () => {
    clearSapId()
    const fetchImpl = router(() => new Response(""))
    const Http = ApicolHttp
    const adapter = new ApicolAdapter(new Http({ baseUrl: "https://apicol.test", fetchImpl }))
    const out = await adapter.list({ appId: "1279" })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain("token")
  })
})