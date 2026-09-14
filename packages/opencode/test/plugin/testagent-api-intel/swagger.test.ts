import { describe, expect, test } from "bun:test"
import { parseSwagger } from "@/plugin/testagent-api-intel/core/swagger"

describe("parseSwagger", () => {
  test("extracts input/output schema from a simple OpenAPI 3 doc", () => {
    const doc = {
      openapi: "3.0.0",
      info: { title: "x", version: "1" },
      paths: {
        "/test2": {
          post: {
            parameters: [{ name: "x", in: "query", required: true, schema: { type: "string" } }],
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "object", properties: { a: { type: "integer" } } } } },
            },
            responses: {
              "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } } },
              "401": { description: "auth" },
              "500": { description: "oops" },
            },
          },
        },
      },
    }
    const out = parseSwagger(JSON.stringify(doc))
    const op = out.operations["POST /test2"]
    expect(op).toBeTruthy()
    expect(op!.inputSchema.properties).toMatchObject({ x: { type: "string" }, body: { type: "object" } })
    expect(op!.inputSchema.required).toEqual(["x", "body"])
    expect(op!.outputSchema).toMatchObject({ type: "object", properties: { id: { type: "string" } } })
    expect(op!.errors).toEqual([
      { status: 401, message: "auth" },
      { status: 500, message: "oops" },
    ])
    expect(out.unresolved).toBe(false)
  })

  test("marks unresolved when $ref appears", () => {
    const doc = {
      swagger: "2.0",
      info: { title: "x", version: "1" },
      paths: {
        "/pets/{id}": {
          get: {
            parameters: [{ name: "id", in: "path", required: true, schema: { $ref: "#/definitions/Id" } }],
            responses: { "200": { description: "ok", schema: { $ref: "#/definitions/Pet" } } },
          },
        },
      },
    }
    const out = parseSwagger(JSON.stringify(doc))
    const op = out.operations["GET /pets/{id}"]
    expect(op).toBeTruthy()
    expect(op!.inputSchema["unresolved"]).toBe(true)
    expect(op!.outputSchema["unresolved"]).toBe(true)
    expect(out.unresolved).toBe(true)
  })
})