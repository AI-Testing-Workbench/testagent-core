import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ApicolAuth } from "@/plugin/testagent-api-intel/core/auth"

const USER_MODULE_PATH = "@/testagent/user"
const ORIGINAL_USER = await import(USER_MODULE_PATH)
const ORIGINAL_PROCESS_ENV = { ...process.env }

function setUser(sapId: string | undefined) {
  if (sapId === undefined) {
    ORIGINAL_USER.User.set({} as any)
  } else {
    ORIGINAL_USER.User.set({ userId: "u-test", sapId } as any)
  }
}

function makeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString()
    return handler(url, init)
  }) as unknown as typeof fetch
}

describe("ApicolAuth", () => {
  beforeEach(() => {
    process.env["APICOL_BASE_URL"] = "https://apicol.test"
    delete process.env["TESTAGENT_SAP_ID"]
    delete process.env["TESTAGENT_USER_ID"]
    setUser("80249496")
  })

  afterEach(() => {
    setUser(undefined)
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIGINAL_PROCESS_ENV)) delete process.env[k]
    }
    for (const [k, v] of Object.entries(ORIGINAL_PROCESS_ENV)) {
      if (v === undefined) continue
      process.env[k] = v
    }
  })

  test("GETs token with sapId query and no extra headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = makeFetch((url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ returnCode: "SUC0000", body: { token: "t-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })

    const auth = new ApicolAuth({ baseUrl: "https://apicol.test", fetchImpl })
    const tok = await auth.getToken()
    expect(tok).toBe("t-1")
    expect(calls).toHaveLength(1)
    expect(calls[0].init.method).toBe("GET")
    expect(calls[0].url).toBe("https://apicol.test/ed/openapi/token?sapId=80249496")
    const headers = calls[0].init.headers as Record<string, string> | undefined
    if (headers) {
      for (const k of Object.keys(headers)) {
        expect(["authorization", "content-type"]).toContain(k.toLowerCase())
      }
    }
  })

  test("throws when sapId is missing", async () => {
    setUser(undefined)
    const auth = new ApicolAuth({ baseUrl: "https://apicol.test", fetchImpl: makeFetch(() => new Response("")) })
    await expect(auth.getToken()).rejects.toThrow(/sapId/)
  })

  test("throws on non-SUC0000 returnCode", async () => {
    const fetchImpl = makeFetch(() =>
      new Response(JSON.stringify({ returnCode: "ERR001", errorMsg: "denied" }), { status: 200 }),
    )
    const auth = new ApicolAuth({ baseUrl: "https://apicol.test", fetchImpl })
    await expect(auth.getToken()).rejects.toThrow(/ERR001/)
  })

  test("throws when body.token missing", async () => {
    const fetchImpl = makeFetch(() => new Response(JSON.stringify({ returnCode: "SUC0000", body: {} }), { status: 200 }))
    const auth = new ApicolAuth({ baseUrl: "https://apicol.test", fetchImpl })
    await expect(auth.getToken()).rejects.toThrow(/token/)
  })

  test("throws on HTTP 500", async () => {
    const fetchImpl = makeFetch(() => new Response("oops", { status: 500 }))
    const auth = new ApicolAuth({ baseUrl: "https://apicol.test", fetchImpl })
    await expect(auth.getToken()).rejects.toThrow(/HTTP 500/)
  })
})