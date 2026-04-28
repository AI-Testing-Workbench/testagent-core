#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

await import("./generate.ts")

// Load migrations from migration directories
const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MIGRATIONS: JSON.stringify(migrations),
    OPENCODE_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

// Copy WASM assets to dist/node/chunks/ (tree-sitter parsers)
const chunksDir = path.join(dir, "dist/node/chunks")
if (!fs.existsSync(chunksDir)) {
  fs.mkdirSync(chunksDir, { recursive: true })
}

const wasmPackages = ["web-tree-sitter", "tree-sitter-bash", "tree-sitter-powershell"]
const nodeModulesDirs = [
  path.join(dir, "node_modules"),
  path.resolve(dir, "../../node_modules"),
]

for (const pkg of wasmPackages) {
  for (const nmDir of nodeModulesDirs) {
    const pkgDir = path.join(nmDir, pkg)
    if (!fs.existsSync(pkgDir)) continue
    for (const file of fs.readdirSync(pkgDir, { recursive: true }) as string[]) {
      if (!file.endsWith(".wasm")) continue
      const src = path.join(pkgDir, file)
      const dest = path.join(chunksDir, path.basename(file))
      fs.copyFileSync(src, dest)
      console.log(`Copied WASM: ${path.basename(file)}`)
    }
    break
  }
}

console.log("Build complete")
