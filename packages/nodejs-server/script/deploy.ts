#!/usr/bin/env bun
// testagent-core_change - new file
// 打包 node 运行时发行版并部署到 kilo-vscode：
//   nodejs-server build → 拷 dist/* 到 ../kilo-vscode/nodejs-server/（保留已 npm install 的 node_modules）
//   → 拷 wrapper 到 ../kilo-vscode/bin/
// 用法：bun packages/nodejs-server/script/deploy.ts（已挂在根 package.json 的 bun:mac / bun:windows 里）
import { $ } from "bun"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../../..") // packages/testagent-core
const SERVER_PKG = path.join(ROOT, "packages/nodejs-server")
const DIST = path.join(SERVER_PKG, "dist")
const KILO = path.join(ROOT, "../kilo-vscode")

await $`bun run --cwd ${SERVER_PKG} build`

const target = path.join(KILO, "nodejs-server")
await fs.promises.mkdir(target, { recursive: true })
// 整目录覆盖式拷贝；ponytail: 不清理上次构建的残留文件，dist 文件名带 hash 基本不会撞，出问题手动删目录重拷
await $`cp -R ${path.join(DIST, ".")} ${target}/`

const bin = path.join(KILO, "bin")
await fs.promises.mkdir(bin, { recursive: true })
for (const w of ["testagent-node", "testagent-node.cmd"]) {
  await $`cp ${path.join(SERVER_PKG, "deploy", w)} ${path.join(bin, w)}`
}
if (process.platform !== "win32") {
  await fs.promises.chmod(path.join(bin, "testagent-node"), 0o755)
}

console.log(`✓ node runtime deployed: ${target}`)
console.log(`  wrappers: ${path.join(bin, "testagent-node")}(.cmd)`)
