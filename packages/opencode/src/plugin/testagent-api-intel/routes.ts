// testagent_change - dispatch for the api_intel tool. 当前仅启用 FA 平台。
//
// apicol（API 协作平台）暂未完成，已【临时下线】：下方 apicol 相关代码整体
// 注释保留，恢复时按「apicol 恢复」标记取消注释即可。注意两处需配合改：
//   1. validate() 里删除 fa-only 的 if 块，启用注释的 switch；
//   2. executeAction() 里把 fa 分支包进 if (args.platform === "fa")，
//      apicol 作为其后的分支。
// platforms/apicol.ts、script/apicol-invoke.ts 及其测试均保留未删。

import type { ToolContext } from "@opencode-ai/plugin"
import { FaAdapter } from "./platforms/fa"

// apicol 恢复：取消下方注释
// import {
//   ApicolAdapter,
//   type FetchAllInput,
//   type FetchInput,
//   type ListInput,
//   type ScanInput,
// } from "./platforms/apicol"

export const ROUTES = {
  faFetch: "GET fa.fetch",
  faWriteMd: "POST fa.writeMd",
  // apicol 恢复：取消下方注释
  // scan: "POST apicol.scan",
  // list: "POST apicol.list",
  // fetch: "POST apicol.fetch",
  // fetchAll: "POST apicol.fetchAll",
} as const

// Action 保留四动作词汇（平台无关的抽象）；当前仅 fetch 可用。
export type Action = "scan" | "list" | "fetch" | "fetchAll"
export type Platform = "fa"
// apicol 恢复：改回  export type Platform = "apicol" | "fa"

export type ApiIntelArgs = {
  action: Action
  platform: Platform
  testProductNo?: string
  testApiName?: string
  testAppName?: string
  outputPath?: string
  // apicol 恢复：取消下方注释
  // systemId?: string
  // deployUnit?: string
  // keyword?: string
  // appId?: string
  // endpointRefs?: string[]
}

function need(args: ApiIntelArgs, key: keyof ApiIntelArgs): string | null {
  const v = args[key]
  if (v === undefined || v === null || v === "") return `action="${args.action}" requires "${key}"`
  return null
}

export function validate(args: ApiIntelArgs): void {
  // apicol 已临时下线：仅放行 fa 的 fetch。
  // apicol 恢复：删除本 if 块，启用下方注释的 switch（按 platform 分发）。
  if (args.action !== "fetch") {
    throw new Error('fa: 仅支持 action="fetch"（scan/list/fetchAll 属 apicol 工作流，apicol 暂未完成已临时下线）')
  }
  for (const key of ["testProductNo", "testApiName", "testAppName"] as const) {
    const err = need(args, key)
    if (err) throw new Error(err)
  }

  // apicol 恢复：取消下方注释
  // switch (args.action) {
  //   case "scan": {
  //     if (args.platform !== "apicol") throw new Error(`action="scan" requires platform="apicol"`)
  //     return
  //   }
  //   case "list": {
  //     const err = need(args, "appId")
  //     if (err) throw new Error(err)
  //     return
  //   }
  //   case "fetch": {
  //     const err1 = need(args, "appId")
  //     if (err1) throw new Error(err1)
  //     if (!Array.isArray(args.endpointRefs) || args.endpointRefs.length === 0) {
  //       throw new Error(`action="fetch" requires non-empty "endpointRefs"`)
  //     }
  //     return
  //   }
  //   case "fetchAll": {
  //     const err = need(args, "appId")
  //     if (err) throw new Error(err)
  //     return
  //   }
  // }
}

export async function executeAction(args: ApiIntelArgs, ctx: ToolContext) {
  validate(args)

  const adapter = new FaAdapter()
  const base = {
    testProductNo: args.testProductNo!,
    testApiName: args.testApiName!,
    testAppName: args.testAppName!,
  }
  // outputPath（目录）有值 → 走第二个接口，生成 md 文件写到 <outputPath>/<file_name>；
  // 否则走第一个接口查询接口定义。
  if (args.outputPath) {
    const out = await adapter.writeMd({ ...base, outputPath: args.outputPath }, ctx.abort)
    return { ...out, route: ROUTES.faWriteMd }
  }
  const out = await adapter.fetch(base, ctx.abort)
  return { ...out, route: ROUTES.faFetch }

  // apicol 恢复：把上方 fa 分支包进 if (args.platform === "fa") { ... }，
  // 然后取消下方注释作为 apicol 分支。
  // const apicol = new ApicolAdapter()
  // switch (args.action) {
  //   case "scan": {
  //     const input: ScanInput = {
  //       ...(args.systemId !== undefined ? { systemId: args.systemId } : {}),
  //       ...(args.deployUnit !== undefined ? { deployUnit: args.deployUnit } : {}),
  //       ...(args.keyword !== undefined ? { keyword: args.keyword } : {}),
  //     }
  //     const r = await apicol.scan(input, ctx.abort)
  //     return { ...r, route: ROUTES.scan }
  //   }
  //   case "list": {
  //     const input: ListInput = { appId: args.appId! }
  //     const r = await apicol.list(input, ctx.abort)
  //     return { ...r, route: ROUTES.list }
  //   }
  //   case "fetch": {
  //     const input: FetchInput = { appId: args.appId!, endpointRefs: args.endpointRefs! }
  //     const r = await apicol.fetch(input, ctx.abort)
  //     return { ...r, route: ROUTES.fetch }
  //   }
  //   case "fetchAll": {
  //     const input: FetchAllInput = { appId: args.appId! }
  //     const r = await apicol.fetchAll(input, ctx.abort)
  //     return { ...r, route: ROUTES.fetchAll }
  //   }
  // }
}
