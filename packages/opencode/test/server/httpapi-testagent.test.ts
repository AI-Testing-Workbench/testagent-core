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
