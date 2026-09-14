import { describe, expect, test } from "bun:test"
import { levenshtein, matchRef, normalizePath, parseEndpointRef, suggestCandidates } from "@/plugin/testagent-api-intel/core/match"

describe("parseEndpointRef", () => {
  test("bare name", () => {
    expect(parseEndpointRef("users_create")).toEqual({ name: "users_create" })
  })

  test("METHOD path", () => {
    expect(parseEndpointRef("POST /api/users")).toEqual({ method: "POST", path: "/api/users" })
  })

  test("METHOD name", () => {
    expect(parseEndpointRef("POST users_create")).toEqual({ method: "POST", name: "users_create" })
  })

  test("invalid empty", () => {
    expect(parseEndpointRef("   ")).toBeNull()
  })
})

describe("normalizePath", () => {
  test("swagger template -> colon template", () => {
    expect(normalizePath("/api/users/{id}")).toBe("/api/users/:id")
  })

  test("trailing slash stripped, lowercased", () => {
    expect(normalizePath("/API/Users/{ID}/")).toBe("/api/users/:id")
  })

  test("colon template unchanged", () => {
    expect(normalizePath("/api/users/:id")).toBe("/api/users/:id")
  })
})

describe("matchRef", () => {
  const candidates = [
    { name: "users_create", method: "POST", path: "/api/users" },
    { name: "users_get", method: "GET", path: "/api/users/{id}" },
    { name: "orders_pay", method: "POST", path: "/api/orders/{id}/pay" },
  ]

  test("matches by name only", () => {
    expect(matchRef({ name: "users_get" }, candidates)).toEqual([
      { name: "users_get", method: "GET", path: "/api/users/{id}" },
    ])
  })

  test("method+path beats method+name", () => {
    const ref = parseEndpointRef("POST /api/users")
    expect(ref).toEqual({ method: "POST", path: "/api/users" })
    expect(matchRef(ref!, candidates)).toEqual([
      { name: "users_create", method: "POST", path: "/api/users" },
    ])
  })

  test("method+name resolves even when path differs", () => {
    expect(matchRef({ method: "POST", name: "orders_pay" }, candidates)).toEqual([
      { name: "orders_pay", method: "POST", path: "/api/orders/{id}/pay" },
    ])
  })

  test("path normalization matches swagger templates", () => {
    const ref = { method: "GET", path: "/api/users/:id" }
    expect(matchRef(ref, candidates)).toEqual([
      { name: "users_get", method: "GET", path: "/api/users/{id}" },
    ])
  })

  test("no match returns empty", () => {
    expect(matchRef({ name: "nope" }, candidates)).toEqual([])
  })
})

describe("levenshtein and suggestCandidates", () => {
  test("levenshtein basics", () => {
    expect(levenshtein("abc", "abc")).toBe(0)
    expect(levenshtein("abc", "abd")).toBe(1)
    expect(levenshtein("kitten", "sitting")).toBe(3)
  })

  test("suggestCandidates ranks closest name first", () => {
    const candidates = [
      { name: "users_create", method: "POST", path: "/api/users" },
      { name: "users_remove", method: "DELETE", path: "/api/users/{id}" },
      { name: "orders_pay", method: "POST", path: "/api/orders/{id}/pay" },
      { name: "auth_login", method: "POST", path: "/api/auth/login" },
    ]
    const ref = "users_remove_xx"
    const dRemove = levenshtein(ref, "DELETE users_remove")
    const dCreate = levenshtein(ref, "POST users_create")
    expect(dRemove).toBeLessThan(dCreate)
    const out = suggestCandidates(ref, candidates, 3)
    expect(out[0].name).toBe("users_remove")
    expect(out).toHaveLength(3)
  })
})