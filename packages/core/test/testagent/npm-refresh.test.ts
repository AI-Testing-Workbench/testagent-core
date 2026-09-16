import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { tmpdir } from "../fixture/tmpdir"

const npmLayer = (cache: string) =>
  Npm.layer.pipe(
    Layer.provide(EffectFlock.layer),
    Layer.provide(AppFileSystem.layer),
    Layer.provide(Global.layerWith({ cache, state: path.join(cache, "state") })),
    Layer.provide(NodeFileSystem.layer),
  )

const add = (spec: string, cache: string, opts?: { refresh?: boolean }) =>
  Effect.gen(function* () {
    const npm = yield* Npm.Service
    return yield* npm.add(spec, opts)
  }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  )

// Builds a local package that can be consumed through a `file:` spec, so the tests never touch a registry.
const fixture = async (dir: string) => {
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture-plugin", version: "1.0.0", main: "index.js" }),
  )
  await Bun.write(path.join(dir, "index.js"), "export const fixture = true\n")
  return dir
}

const setup = async () => {
  const tmp = await tmpdir()
  const spec = `fixture-plugin@file:${await fixture(path.join(tmp.path, "fixture-plugin"))}`
  const cache = path.join(tmp.path, "cache")
  const dir = path.join(cache, "packages", Npm.sanitize(spec))
  const installed = path.join(dir, "node_modules", "fixture-plugin")
  // Claim the package directory without actually installing anything, mimicking a warm cache.
  await fs.mkdir(installed, { recursive: true })
  return { tmp, spec, cache, dir, installed }
}

describe("Npm.add cache handling", () => {
  test("reuses the cached install without reinstalling", async () => {
    const { tmp, spec, cache, dir, installed } = await setup()
    await using _ = tmp

    const entry = await add(spec, cache)

    expect(entry.directory).toBe(installed)
    expect(await exists(path.join(dir, "package-lock.json"))).toBe(false)
    expect(await exists(path.join(installed, "index.js"))).toBe(false)
  })

  test("reinstalls when a refresh is requested even though the package is cached", async () => {
    const { tmp, spec, cache, dir, installed } = await setup()
    await using _ = tmp

    const entry = await add(spec, cache, { refresh: true })

    expect(entry.directory).toBe(installed)
    expect(await exists(path.join(dir, "package-lock.json"))).toBe(true)
    expect(await exists(path.join(installed, "index.js"))).toBe(true)
  })
})
