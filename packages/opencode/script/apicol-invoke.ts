// testagent_change - direct invocation script for the api_intel tool.
// Bypasses the opencode server and exercises the plugin function in-process,
// which is the fastest way to validate behavior end-to-end against the local
// apicol mock.
//
// ⚠️ apicol（API 协作平台）暂未完成，已【临时下线】。本脚本是 apicol 的调试
// 工具，随之暂停：下方整段脚本体注释保留，恢复 apicol 时（见 routes.ts /
// index.ts 的「apicol 恢复」注释块）删除上方 stub、取消下方注释即可重新使用。
//
// Usage（恢复后）：
//   APICOL_BASE_URL=http://127.0.0.1:9999 \
//   TESTAGENT_USER_ID=u-debug TESTAGENT_SAP_ID=80249496 \
//     bun script/apicol-invoke.ts scan --systemId LT37.01 --keyword demo
//   ... fetch --appId 1279 --refs users_create --refs "POST /api/users"

console.error(
  "apicol 平台已临时下线（暂未完成），apicol-invoke.ts 暂停使用。恢复 apicol 后取消下方注释即可。",
)
process.exit(3)

/* ── apicol 恢复：取消下方注释，并删除上方 stub ──────────────────────────────

import { executeAction } from "../src/plugin/testagent-api-intel/routes"
import { User } from "../src/testagent/user"
import type { ApiIntelArgs } from "../src/plugin/testagent-api-intel/routes"

const action = process.argv[2]
if (!action || !["scan", "list", "fetch", "fetchAll"].includes(action)) {
  console.error("usage: bun script/apicol-invoke.ts <scan|list|fetch|fetchAll> [...flags]")
  process.exit(2)
}

const flagMap = new Map<string, string[]>()
for (let i = 3; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!a.startsWith("--")) continue
  const key = a.slice(2)
  const values: string[] = []
  let j = i + 1
  while (j < process.argv.length && !process.argv[j].startsWith("--")) {
    values.push(process.argv[j] ?? "")
    j++
  }
  const existing = flagMap.get(key) ?? []
  flagMap.set(key, [...existing, ...values])
  i = j - 1
}

const single = (key: string): string | undefined => {
  const arr = flagMap.get(key)
  if (!arr || arr.length === 0) return undefined
  return arr[0]
}

const multi = (key: string): string[] => flagMap.get(key) ?? []

const args: ApiIntelArgs = {
  action: action as ApiIntelArgs["action"],
  platform: "apicol",
}

const systemId = single("systemId")
const deployUnit = single("deployUnit")
const keyword = single("keyword")
const appId = single("appId")
const refs = multi("refs")
if (systemId) args.systemId = systemId
if (deployUnit) args.deployUnit = deployUnit
if (keyword) args.keyword = keyword
if (appId) args.appId = appId
if (refs.length > 0) args.endpointRefs = refs

User.set({
  userId: process.env["TESTAGENT_USER_ID"] ?? "u-debug",
  userName: "debugger",
  sapId: process.env["TESTAGENT_SAP_ID"] ?? "80249496",
})

const ctx = {
  sessionID: "s-debug",
  messageID: "m-debug",
  abort: new AbortController().signal,
  metadata: () => undefined,
  ask: () => undefined,
} as unknown as Parameters<typeof executeAction>[1]

try {
  const out = await executeAction(args, ctx)
  console.log(JSON.stringify(out, null, 2))
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  console.error("invoke failed:", msg)
  process.exit(1)
}
*/
