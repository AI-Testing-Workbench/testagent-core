import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs" // testagent_change
import { resource } from "@opencode-ai/core/effect/observability"

const otelResourceAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES
const kiloClient = process.env.KILO_CLIENT // testagent_change
const testagentCloudMode = process.env.TESTAGENT_CLOUD_MODE // testagent_change
const testagentCloudTestValue = process.env.TESTAGENT_CLOUD_TEST_VALUE // testagent_change

afterEach(() => {
  if (otelResourceAttributes === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES
  else process.env.OTEL_RESOURCE_ATTRIBUTES = otelResourceAttributes

  if (kiloClient === undefined) delete process.env.KILO_CLIENT // testagent_change
  else process.env.KILO_CLIENT = kiloClient // testagent_change

  // testagent_change start - restore cloud resource test environment
  if (testagentCloudMode === undefined) delete process.env.TESTAGENT_CLOUD_MODE
  else process.env.TESTAGENT_CLOUD_MODE = testagentCloudMode
  if (testagentCloudTestValue === undefined) delete process.env.TESTAGENT_CLOUD_TEST_VALUE
  else process.env.TESTAGENT_CLOUD_TEST_VALUE = testagentCloudTestValue
  // testagent_change end
})

describe("resource", () => {
  test("parses and decodes OTEL resource attributes", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "service.namespace=anomalyco,team=platform%2Cobservability,label=hello%3Dworld,key%2Fname=value%20here"

    expect(resource().attributes).toMatchObject({
      "service.namespace": "anomalyco",
      team: "platform,observability",
      label: "hello=world",
      "key/name": "value here",
    })
  })

  test("drops OTEL resource attributes when any entry is invalid", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.namespace=anomalyco,broken"

    expect(resource().attributes["service.namespace"]).toBeUndefined()
    expect(resource().attributes["testagent.client"]).toBeDefined() // testagent_change
  })

  test("keeps built-in attributes when env values conflict", () => {
    process.env.KILO_CLIENT = "cli" // testagent_change
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "testagent.client=web,service.instance.id=override,service.namespace=anomalyco" // testagent_change

    expect(resource().attributes).toMatchObject({
      "testagent.client": "cli", // testagent_change
      "service.namespace": "anomalyco",
    })
    expect(resource().attributes["service.instance.id"]).not.toBe("override")
  })

  // testagent_change start - cover cloud environment resource export
  test("reports TESTAGENT_CLOUD environment variables in cloud mode", () => {
    process.env.TESTAGENT_CLOUD_MODE = "1"
    process.env.TESTAGENT_CLOUD_TEST_VALUE = "test-value"

    expect(JSON.parse(resource().attributes["testagent.cloud_env"])).toMatchObject({
      TESTAGENT_CLOUD_MODE: "1",
      TESTAGENT_CLOUD_TEST_VALUE: "test-value",
    })
  })

  test.skipIf(existsSync("/etc/tscode-cloud-mode"))("uses an empty cloud environment outside cloud mode", () => {
    process.env.TESTAGENT_CLOUD_MODE = "0"
    process.env.TESTAGENT_CLOUD_TEST_VALUE = "ignored"

    expect(resource().attributes["testagent.cloud_env"]).toBe("{}")
  })
  // testagent_change end
})
