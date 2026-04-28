#!/usr/bin/env bun
import { $ } from "bun"
import { join } from "node:path"
import { rm, mkdir, cp, writeFile } from "node:fs/promises"

const ROOT = join(import.meta.dir, "../../..")
const OPENCODE_PKG = join(ROOT, "packages/opencode")
const SERVER_PKG = join(ROOT, "packages/opencode-server")
const DIST = join(SERVER_PKG, "dist")

console.log("Building OpenCode Node.js Server...")

// Step 1: Build Node.js bundle from opencode package
console.log("Step 1: Building Node.js bundle...")
await $`cd ${OPENCODE_PKG} && bun run script/build-node.ts`

// Step 2: Clean and create dist directory
console.log("Step 2: Preparing dist directory...")
await rm(DIST, { recursive: true, force: true })
await mkdir(DIST, { recursive: true })

// Step 3: Copy all files from opencode/dist/node/ to dist/
console.log("Step 3: Copying Node.js bundle...")
const NODE_DIST = join(OPENCODE_PKG, "dist/node")
await cp(NODE_DIST, DIST, { recursive: true })

// Step 4: Copy cli.mjs to dist/
console.log("Step 4: Copying CLI entry point...")
await cp(join(SERVER_PKG, "cli.mjs"), join(DIST, "cli.mjs"))

// Step 5: Generate distribution package.json
console.log("Step 5: Generating distribution package.json...")
const pkg = await Bun.file(join(SERVER_PKG, "package.json")).json()
const distPkg = {
  name: pkg.name,
  version: pkg.version,
  type: pkg.type,
  description: pkg.description,
  bin: pkg.bin,
  engines: pkg.engines,
  dependencies: pkg.dependencies,
  optionalDependencies: pkg.optionalDependencies,
}
await writeFile(join(DIST, "package.json"), JSON.stringify(distPkg, null, 2))

console.log("✓ Build complete!")
console.log(`Distribution ready at: ${DIST}`)
console.log("\nTo run the server:")
console.log(`  cd ${DIST}`)
console.log("  node --experimental-sqlite cli.mjs")
