import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"
import { waitGlobalBusEventPromise } from "./global-bus"

void Log.init({ print: false })

function app() {
  return Server.Default().app
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("testagent zh-answer HttpApi", () => {
  test("toggles emit process-wide zh.answer.toggled event via GlobalBus", async () => {
    const received = waitGlobalBusEventPromise({
      message: "timed out waiting for zh.answer.toggled",
      predicate: (event) => event.payload.type === "zh.answer.toggled",
    })

    const response = await app().request("/testagent/zh-answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toBe(true)

    const event = await received
    expect(event.payload.properties.enabled).toBe(true)
  })
})

// testagent_change start
describe("testagent server auth HttpApi", () => {
  test("returns a null token when no server password is configured", async () => {
    const previous = process.env["OPENCODE_SERVER_PASSWORD"]
    delete process.env["OPENCODE_SERVER_PASSWORD"]
    try {
      const response = await app().request("/testagent/server/auth")
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ username: "opencode", token: null })
    } finally {
      if (previous !== undefined) process.env["OPENCODE_SERVER_PASSWORD"] = previous
    }
  })

  test("returns the base64 credential that the web UI share link embeds", async () => {
    const previous = process.env["OPENCODE_SERVER_PASSWORD"]
    process.env["OPENCODE_SERVER_PASSWORD"] = "secret123"
    try {
      const expected = Buffer.from("opencode:secret123").toString("base64")
      const response = await app().request("/testagent/server/auth", {
        headers: { authorization: `Basic ${expected}` },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ username: "opencode", token: expected })
    } finally {
      if (previous === undefined) delete process.env["OPENCODE_SERVER_PASSWORD"]
      else process.env["OPENCODE_SERVER_PASSWORD"] = previous
    }
  })

  test("is reachable without credentials when TESTAGENT_SERVER_AUTH_PUBLIC is enabled", async () => {
    const previousPassword = process.env["OPENCODE_SERVER_PASSWORD"]
    const previousPublic = process.env["TESTAGENT_SERVER_AUTH_PUBLIC"]
    process.env["OPENCODE_SERVER_PASSWORD"] = "secret123"
    process.env["TESTAGENT_SERVER_AUTH_PUBLIC"] = "1"
    try {
      const expected = Buffer.from("opencode:secret123").toString("base64")
      const response = await app().request("/testagent/server/auth")
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ username: "opencode", token: expected })
    } finally {
      if (previousPassword === undefined) delete process.env["OPENCODE_SERVER_PASSWORD"]
      else process.env["OPENCODE_SERVER_PASSWORD"] = previousPassword
      if (previousPublic === undefined) delete process.env["TESTAGENT_SERVER_AUTH_PUBLIC"]
      else process.env["TESTAGENT_SERVER_AUTH_PUBLIC"] = previousPublic
    }
  })
})
// testagent_change end
