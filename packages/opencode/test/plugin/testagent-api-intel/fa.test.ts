import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { FaAdapter } from "@/plugin/testagent-api-intel/platforms/fa"
import { FaHttp } from "@/plugin/testagent-api-intel/core/fa-http"
import { validate } from "@/plugin/testagent-api-intel/routes"

const ORIGINAL_PROCESS_ENV = { ...process.env }

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

describe("FaAdapter", () => {
  beforeEach(() => {
    process.env["FA_BASE_URL"] = "https://fa.test"
    process.env["TESTAGENT_USER_TOKEN"] = "t-token"
  })

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIGINAL_PROCESS_ENV)) delete process.env[k]
    }
    for (const [k, v] of Object.entries(ORIGINAL_PROCESS_ENV)) {
      if (v === undefined) continue
      process.env[k] = v
    }
  })

  test("fetch maps the registered api into endpoint + definition", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = router((url, init) => {
      calls.push({ url, init })
      return json({
        returnCode: "SUC0000",
        body: {
          testApiId: "10245",
          testApiName: "getOrderDetail",
          testApiDefine: '{"request":"orderNo:String","response":"OrderDetail"}',
          testApiUri: "/api/v1/order/detail",
          testApiMethod: "GET",
          testApiResponse: '{"orderNo":"String","status":"String"}',
        },
      })
    })
    const adapter = new FaAdapter(new FaHttp({ baseUrl: "https://fa.test", fetchImpl }))
    const out = await adapter.fetch({ testProductNo: "P10001", testApiName: "getOrderDetail", testAppName: "order-service" })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data.matched).toHaveLength(1)
    expect(out.data.unmatched).toHaveLength(0)
    const m = out.data.matched[0]
    expect(m.endpoint).toMatchObject({
      apiId: "10245",
      name: "getOrderDetail",
      method: "GET",
      path: "/api/v1/order/detail",
    })
    expect(m.definition.inputSchema).toEqual({ request: "orderNo:String", response: "OrderDetail" })
    expect(m.definition.outputSchema).toEqual({ orderNo: "String", status: "String" })
    expect(m.definition.errors).toEqual([])

    const biz = calls[0]
    expect(biz.init.method).toBe("GET")
    expect(biz.url).toContain("/testagent-plugin/fa-api-intel")
    expect(biz.url).toContain("testProductNo=P10001")
    expect(biz.url).toContain("testApiName=getOrderDetail")
    expect(biz.url).toContain("testAppName=order-service")
    const headers = biz.init.headers as Record<string, string> | undefined
    expect(headers?.["authorization"]).toBe("t-token")
  })

  test("fetch returns unmatched when body is empty", async () => {
    const fetchImpl = router(() => json({ returnCode: "SUC0000", body: {}, errorMsg: "" }))
    const adapter = new FaAdapter(new FaHttp({ baseUrl: "https://fa.test", fetchImpl }))
    const out = await adapter.fetch({ testProductNo: "P10001", testApiName: "nope", testAppName: "x" })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data.matched).toHaveLength(0)
    expect(out.data.unmatched).toHaveLength(1)
    expect(out.data.unmatched[0].reason).toBe("未匹配到接口")
  })

  test("unparseable define/schema falls back to raw string", async () => {
    const fetchImpl = router(() =>
      json({
        returnCode: "SUC0000",
        body: {
          testApiId: "1",
          testApiName: "x",
          testApiDefine: "not json",
          testApiUri: "/x",
          testApiResponse: "also not json",
        },
      }),
    )
    const adapter = new FaAdapter(new FaHttp({ baseUrl: "https://fa.test", fetchImpl }))
    const out = await adapter.fetch({ testProductNo: "P", testApiName: "x", testAppName: "a" })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.data.matched[0].definition.inputSchema).toEqual({ raw: "not json" })
    expect(out.data.matched[0].definition.outputSchema).toEqual({ raw: "also not json" })
  })

  test("empty base URL returns config error without making a request", async () => {
    const calls: string[] = []
    const fetchImpl = router((url) => {
      calls.push(url)
      return json({})
    })
    const adapter = new FaAdapter(new FaHttp({ baseUrl: "", fetchImpl }))
    const out = await adapter.fetch({ testProductNo: "P", testApiName: "x", testAppName: "a" })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain("base URL 未配置")
    expect(out.platform).toBe("fa")
    expect(calls).toHaveLength(0)
  })

  test("missing token returns config error without making a request", async () => {
    delete process.env["TESTAGENT_USER_TOKEN"]
    const calls: string[] = []
    const fetchImpl = router((url) => {
      calls.push(url)
      return json({})
    })
    const adapter = new FaAdapter(new FaHttp({ baseUrl: "https://fa.test", fetchImpl }))
    const out = await adapter.fetch({ testProductNo: "P", testApiName: "x", testAppName: "a" })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain("accessToken 未配置")
    expect(out.platform).toBe("fa")
    expect(calls).toHaveLength(0)
  })

  test("business failures return envelope error, not exception", async () => {
    const fetchImpl = router(() => json({ returnCode: "ERR007", errorMsg: "forbidden" }))
    const adapter = new FaAdapter(new FaHttp({ baseUrl: "https://fa.test", fetchImpl }))
    const out = await adapter.fetch({ testProductNo: "P", testApiName: "x", testAppName: "a" })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain("forbidden")
    expect(out.platform).toBe("fa")
  })
})

describe("validate (platform=fa)", () => {
  test("accepts fetch with all three fa fields", () => {
    expect(() =>
      validate({
        action: "fetch",
        platform: "fa",
        testProductNo: "P",
        testApiName: "n",
        testAppName: "a",
      }),
    ).not.toThrow()
  })

  test("rejects non-fetch actions for fa", () => {
    expect(() => validate({ action: "scan", platform: "fa" })).toThrow(/仅支持 action="fetch"/)
    expect(() => validate({ action: "list", platform: "fa", appId: "1" })).toThrow(/仅支持 action="fetch"/)
    expect(() => validate({ action: "fetchAll", platform: "fa", appId: "1" })).toThrow(/仅支持 action="fetch"/)
  })

  test("rejects fa fetch missing a required field", () => {
    expect(() => validate({ action: "fetch", platform: "fa", testProductNo: "P", testApiName: "n" })).toThrow(
      /testAppName/,
    )
  })

  test("leaves apicol validation untouched", () => {
    expect(() => validate({ action: "scan", platform: "apicol" })).not.toThrow()
    expect(() => validate({ action: "fetch", platform: "apicol", appId: "1" })).toThrow(/endpointRefs/)
  })
})
