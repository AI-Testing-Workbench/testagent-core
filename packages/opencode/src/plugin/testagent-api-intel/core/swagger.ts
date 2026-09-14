// testagent_change - lightweight swagger (OpenAPI 2/3) extraction from the
// Apicol swagger export. Does NOT dereference $ref (avoids the
// @apidevtools/swagger-parser dependency for now). If a schema or response
// contains an unresolved $ref, the slot is marked so callers know.

export type EndpointDefinition = {
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  examples?: { request?: unknown; response?: unknown }
  errors: Array<{ status: number; code?: string; message: string }>
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function methodOk(m: string): m is "get" | "post" | "put" | "delete" | "patch" | "head" | "options" {
  return ["get", "post", "put", "delete", "patch", "head", "options"].includes(m)
}

function getContentSchema(content: unknown): Record<string, unknown> | null {
  const c = asObject(content)
  if (!c) return null
  const appJson = asObject(c["application/json"])
  if (appJson) {
    const s = asObject(appJson["schema"])
    if (s) return s
  }
  const formUrl = asObject(c["application/x-www-form-urlencoded"])
  if (formUrl) {
    const s = asObject(formUrl["schema"])
    if (s) return s
  }
  return null
}

function collectInputSchema(operation: Record<string, unknown>): Record<string, unknown> {
  const parameters = asArray(operation.parameters).map(asObject).filter(Boolean) as Record<string, unknown>[]
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  let hasUnresolved = false

  for (const p of parameters) {
    const name = typeof p.name === "string" ? p.name : null
    if (!name) continue
    const schema = asObject(p.schema)
    if (!schema || schema.$ref !== undefined) {
      hasUnresolved = true
      continue
    }
    properties[name] = schema
    if (typeof p.required === "boolean" && p.required) required.push(name)
  }

  const requestBody = asObject(operation.requestBody)
  if (requestBody) {
    const content = asObject(requestBody.content)
    if (content) {
      const schema = getContentSchema(content)
      if (schema) {
        properties["body"] = schema
        if (typeof requestBody.required === "boolean" && requestBody.required) {
          required.push("body")
        }
      } else {
        hasUnresolved = true
      }
    }
  }

  const result: Record<string, unknown> = { type: "object", properties }
  if (required.length > 0) result["required"] = required
  if (hasUnresolved) result["unresolved"] = true
  return result
}

function collectOutputSchema(operation: Record<string, unknown>): Record<string, unknown> {
  const responses = asObject(operation.responses)
  if (!responses) return { unresolved: true }
  for (const [code, raw] of Object.entries(responses)) {
    if (!/^2\d\d$/.test(code)) continue
    const r = asObject(raw)
    if (!r) continue
    const content = asObject(r.content)
    if (!content) return { unresolved: true }
    const schema = getContentSchema(content)
    if (!schema || schema.$ref !== undefined) return { unresolved: true }
    return schema
  }
  // OpenAPI 2 (Swagger) 用 schema 而不是 content
  for (const [code, raw] of Object.entries(responses)) {
    if (!/^2\d\d$/.test(code)) continue
    const r = asObject(raw)
    if (!r) continue
    const schema = asObject(r.schema)
    if (schema && schema.$ref === undefined) return schema
  }
  return { unresolved: true }
}

function collectErrors(operation: Record<string, unknown>): Array<{ status: number; code?: string; message: string }> {
  const out: Array<{ status: number; code?: string; message: string }> = []
  const responses = asObject(operation.responses)
  if (!responses) return out
  for (const [code, raw] of Object.entries(responses)) {
    if (!/^[45]\d\d$/.test(code)) continue
    const r = asObject(raw)
    if (!r) continue
    const status = parseInt(code, 10)
    const desc = typeof r.description === "string" ? r.description : ""
    const code2 = typeof r.code === "string" ? r.code : undefined
    out.push(code2 ? { status, code: code2, message: desc } : { status, message: desc })
  }
  return out
}

export function parseSwagger(swaggerText: string): {
  operations: Record<string, EndpointDefinition>
  unresolved: boolean
} {
  const doc = asObject(JSON.parse(swaggerText))
  const operations: Record<string, EndpointDefinition> = {}
  let unresolved = false
  if (!doc) return { operations, unresolved: true }

  const paths = asObject(doc.paths)
  if (!paths) return { operations, unresolved: true }

  for (const [pathTemplate, rawItem] of Object.entries(paths)) {
    const item = asObject(rawItem)
    if (!item) continue
    for (const [m, rawOp] of Object.entries(item)) {
      if (!methodOk(m)) continue
      const op = asObject(rawOp)
      if (!op) continue
      const input = collectInputSchema(op)
      const output = collectOutputSchema(op)
      const errors = collectErrors(op)
      if (input["unresolved"] === true || output["unresolved"] === true) {
        unresolved = true
      }
      const key = `${m.toUpperCase()} ${pathTemplate}`
      operations[key] = { inputSchema: input, outputSchema: output, errors }
    }
  }

  return { operations, unresolved }
}