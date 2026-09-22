import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Path } from "@opencode-ai/core/global"
import { EnvVars } from "../../src/testagent/env-vars"
import { User } from "../../src/testagent/user"

const file = () => path.join(Path.data, "env-vars.json")

/** What the stub endpoint replies with; flipped per test. */
let reply: { status?: number; body: unknown } = { body: {} }
let queries: URLSearchParams[] = []
let server: ReturnType<typeof Bun.serve>

// the real endpoint returns lowercase, separator-free field names
const keys = { appid: "app-1", secret: "sec-1", publickey: "pub-1", privatekey: "priv-1" }

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      queries.push(new URL(req.url).searchParams)
      if (reply.status && reply.status !== 200) return new Response("", { status: reply.status })
      return Response.json(reply.body)
    },
  })
  // same path as the real gateway endpoint, only the host differs
  process.env["TESTAGENT_KEY_URL"] = `http://127.0.0.1:${server.port}/application-key/ts-code/by-dept`
  User.set({ userId: "test-user", userName: "tester", originPathId: "123" })
})

afterAll(() => {
  server.stop(true)
  delete process.env["TESTAGENT_KEY_URL"]
})

beforeEach(async () => {
  queries = []
  reply = { body: { returnCode: "SUC0000", body: keys } }
  User.set({ userId: "test-user", userName: "tester", originPathId: "123" })
  await fs.rm(file(), { force: true })
  await EnvVars.clearRemote()
})

describe("testagent remote env vars", () => {
  test("ensureRemote queries by-dept with originPathId and persists the keys", async () => {
    const result = await EnvVars.ensureRemote()

    expect(queries.length).toBe(1)
    expect(queries[0]?.get("pathCode")).toBe("123")

    expect(result.created).toBe(true)
    expect(result.keys).toContain("TESTAGENT_APP_ID")
    expect(result.keys).toContain("TESTAGENT_SECRET")
    expect(result.keys).toContain("TESTAGENT_PUBLIC_KEY")
    expect(result.keys).toContain("TESTAGENT_PRIVATE_KEY")
    expect(await EnvVars.hasRemote()).toBe(true)

    const vars = await EnvVars.getAll()
    expect(Object.keys(vars.remote).sort()).toEqual([...result.keys].sort())
    expect(process.env.TESTAGENT_APP_ID).toBe("app-1")

    // persisted, not just in memory
    expect(JSON.parse(await fs.readFile(file(), "utf-8")).TESTAGENT_SECRET).toBe("sec-1")
  })

  test("ensureRemote accepts a lowercase returncode envelope", async () => {
    reply = { body: { returncode: "SUC0000", body: keys } }

    const result = await EnvVars.ensureRemote()

    expect(result.created).toBe(true)
    expect((await EnvVars.getAll()).remote.TESTAGENT_APP_ID?.value).toBe("app-1")
  })

  test("ensureRemote keeps existing values instead of fetching again", async () => {
    await EnvVars.ensureRemote()
    queries = []
    await fs.writeFile(file(), JSON.stringify({ TESTAGENT_APP_ID: "kept" }), "utf-8")

    const result = await EnvVars.ensureRemote()

    expect(queries.length).toBe(0)
    expect(result).toEqual({ created: false, keys: [] })
    expect((await EnvVars.getAll()).remote.TESTAGENT_APP_ID?.value).toBe("kept")
  })

  test("ensureRemote still fetches when only an unrelated TESTAGENT variable exists", async () => {
    await EnvVars.batchCreate([{ key: "TESTAGENT_CUSTOM", value: "from-user" }])

    const result = await EnvVars.ensureRemote()

    expect(queries.length).toBe(1)
    expect(result.created).toBe(true)
    const vars = await EnvVars.getAll()
    expect(vars.custom.TESTAGENT_CUSTOM?.value).toBe("from-user")
    expect(vars.remote.TESTAGENT_APP_ID?.value).toBe("app-1")

    await EnvVars.batchDelete(["TESTAGENT_CUSTOM"])
  })

  test("ensureRemote skips the endpoint when originPathId is missing", async () => {
    User.set({ userId: "test-user", userName: "tester" })

    const result = await EnvVars.ensureRemote()

    expect(queries.length).toBe(0)
    expect(result.created).toBe(false)
  })

  test("ensureRemote stores nothing when the endpoint reports a business error", async () => {
    reply = { body: { returnCode: "ERR9999", errorMsg: "no permission" } }

    const result = await EnvVars.ensureRemote()

    expect(result.created).toBe(false)
    expect(queries.length).toBe(1)
    expect((await EnvVars.getAll()).remote).toEqual({})
    await expect(fs.readFile(file(), "utf-8")).rejects.toThrow()
  })

  test("ensureRemote stores nothing when the endpoint is not ok", async () => {
    reply = { status: 500, body: {} }

    const result = await EnvVars.ensureRemote()

    expect(result.created).toBe(false)
    expect((await EnvVars.getAll()).remote).toEqual({})
  })

  test("ensureRemote stores nothing when the successful response body is null", async () => {
    reply = { body: { returnCode: "SUC0000", body: null } }

    const result = await EnvVars.ensureRemote()

    expect(queries.length).toBe(1)
    expect(result).toEqual({ created: false, keys: [] })
    expect((await EnvVars.getAll()).remote).toEqual({})
    await expect(fs.readFile(file(), "utf-8")).rejects.toThrow()
  })

  test("ensureRemote stores nothing when the response body has no usable fields", async () => {
    reply = { body: { returnCode: "SUC0000", body: { appid: "", secret: null } } }

    const result = await EnvVars.ensureRemote()

    expect(result.created).toBe(false)
    expect((await EnvVars.getAll()).remote).toEqual({})
  })

  test("ensureRemote maps camelCase field names onto the same uppercase keys", async () => {
    reply = { body: { returnCode: "SUC0000", body: { appId: "app-1", publicKey: "pub-1" } } }

    const result = await EnvVars.ensureRemote()

    expect(result.keys.sort()).toEqual(["TESTAGENT_APP_ID", "TESTAGENT_PUBLIC_KEY"])
    const vars = await EnvVars.getAll()
    expect(vars.remote.TESTAGENT_APP_ID?.value).toBe("app-1")
    expect(vars.remote.TESTAGENT_PUBLIC_KEY?.value).toBe("pub-1")
  })

  test("ensureRemote maps fields that already carry the TESTAGENT prefix", async () => {
    reply = { body: { returnCode: "SUC0000", body: { testagent_app_id: "app-1", testagent_secret: "sec-1" } } }

    const result = await EnvVars.ensureRemote()

    expect(result.keys.sort()).toEqual(["TESTAGENT_APP_ID", "TESTAGENT_SECRET"])
    const vars = await EnvVars.getAll()
    expect(vars.remote.TESTAGENT_SECRET?.value).toBe("sec-1")
  })

  test("ensureRemote stores nothing when the whole payload is null", async () => {
    reply = { body: null }

    const result = await EnvVars.ensureRemote()

    expect(result.created).toBe(false)
    expect((await EnvVars.getAll()).remote).toEqual({})
  })

  test("clearRemote removes the remote keys from the shared file and the process env entries", async () => {
    await EnvVars.ensureRemote()
    expect(process.env.TESTAGENT_SECRET).toBe("sec-1")

    await EnvVars.clearRemote()

    expect(await EnvVars.hasRemote()).toBe(false)
    expect((await EnvVars.getAll()).remote).toEqual({})
    expect(process.env.TESTAGENT_SECRET).toBeUndefined()
    expect(JSON.parse(await fs.readFile(file(), "utf-8"))).toEqual({})
  })

  test("clearRemote leaves custom env vars untouched in the same file", async () => {
    await EnvVars.batchCreate([{ key: "TESTAGENT_KEEP_ME", value: "1" }])
    await EnvVars.ensureRemote()

    await EnvVars.clearRemote()

    const vars = await EnvVars.getAll()
    expect(vars.custom.TESTAGENT_KEEP_ME?.value).toBe("1")
    expect(vars.remote).toEqual({})
    expect(JSON.parse(await fs.readFile(file(), "utf-8"))).toEqual({ TESTAGENT_KEEP_ME: "1" })

    await EnvVars.batchDelete(["TESTAGENT_KEEP_ME"])
  })
})
