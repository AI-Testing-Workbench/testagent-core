#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

await import("./generate.ts")

// testagent_change start - embed the web UI as real files in the node distribution
const appDir = path.join(dir, "..", "app")
const appDist = path.join(appDir, "dist")
const webUiDir = path.join(dir, "dist/node/web-ui")
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")

const createEmbeddedWebUIBundle = async () => {
  console.log("Building Web UI to embed in the node server")
  if (!fs.existsSync(appDist)) {
    await $`bun run --cwd ${appDir} build`
  } else {
    console.log("Web UI dist already exists, skipping vite build")
  }
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: appDist })))
    .map((file) => file.replaceAll("\\", "/"))
    .sort()
  return [
    `import { fileURLToPath } from "node:url"`,
    `import { join } from "node:path"`,
    `const base = fileURLToPath(new URL("./web-ui/", import.meta.url))`,
    `export default {`,
    ...files.map((file) => `  ${JSON.stringify(file)}: join(base, ${JSON.stringify(file)}),`),
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? "" : await createEmbeddedWebUIBundle()
// testagent_change end

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
  external: ["jsonc-parser", "@lydell/node-pty", "@node-rs/jieba"],
  define: {
    OPENCODE_MIGRATIONS: JSON.stringify(migrations),
    OPENCODE_CHANNEL: `'${Script.channel}'`,
    TESTAGENT_VERSION: '1.3.0', // testagent_change - match value from build.ts
  },
  files: {
    "opencode-web-ui.gen.ts": embeddedFileMap, // testagent_change - embed web UI map for node
  },
})

// testagent_change start - ship the web UI assets next to node.js
await fs.promises.rm(webUiDir, { recursive: true, force: true })
if (!skipEmbedWebUi) {
  await fs.promises.cp(appDist, webUiDir, { recursive: true })
  console.log(`Copied Web UI to ${path.relative(dir, webUiDir)}`)
}
// testagent_change end

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
