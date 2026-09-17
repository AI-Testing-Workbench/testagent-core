// testagent_change - dispatch for the api_intel tool. First-stage supports
// only the apicol platform (API 协作平台). FTC/FA are intentionally omitted.

import type { ToolContext } from "@opencode-ai/plugin"
import { ApicolAdapter, type FetchAllInput, type FetchInput, type ListInput, type ScanInput } from "./platforms/apicol"
import { FaAdapter, type FetchInput as FaFetchInput } from "./platforms/fa"

export const ROUTES = {
  scan: "POST apicol.scan",
  list: "POST apicol.list",
  fetch: "POST apicol.fetch",
  fetchAll: "POST apicol.fetchAll",
  faFetch: "GET fa.fetch",
} as const

export type Action = "scan" | "list" | "fetch" | "fetchAll"
export type Platform = "apicol" | "fa"

export type ApiIntelArgs = {
  action: Action
  platform: Platform
  systemId?: string
  deployUnit?: string
  keyword?: string
  appId?: string
  endpointRefs?: string[]
  testProductNo?: string
  testApiName?: string
  testAppName?: string
}

function need(args: ApiIntelArgs, key: keyof ApiIntelArgs): string | null {
  const v = args[key]
  if (v === undefined || v === null || v === "") return `action="${args.action}" requires "${key}"`
  return null
}

export function validate(args: ApiIntelArgs): void {
  if (args.platform === "fa") {
    if (args.action !== "fetch") {
      throw new Error('fa: 仅支持 action="fetch"（FA 无 scan/list/fetchAll 工作流）')
    }
    for (const key of ["testProductNo", "testApiName", "testAppName"] as const) {
      const err = need(args, key)
      if (err) throw new Error(err)
    }
    return
  }

  switch (args.action) {
    case "scan": {
      if (args.platform !== "apicol") {
        throw new Error(`action="scan" requires platform="apicol"`)
      }
      return
    }
    case "list": {
      const err = need(args, "appId")
      if (err) throw new Error(err)
      return
    }
    case "fetch": {
      const err1 = need(args, "appId")
      if (err1) throw new Error(err1)
      if (!Array.isArray(args.endpointRefs) || args.endpointRefs.length === 0) {
        throw new Error(`action="fetch" requires non-empty "endpointRefs"`)
      }
      return
    }
    case "fetchAll": {
      const err = need(args, "appId")
      if (err) throw new Error(err)
      return
    }
  }
}

export async function executeAction(args: ApiIntelArgs, ctx: ToolContext) {
  validate(args)

  if (args.platform === "fa") {
    const adapter = new FaAdapter()
    const input: FaFetchInput = {
      testProductNo: args.testProductNo!,
      testApiName: args.testApiName!,
      testAppName: args.testAppName!,
    }
    const out = await adapter.fetch(input, ctx.abort)
    return { ...out, route: ROUTES.faFetch }
  }

  const adapter = new ApicolAdapter()

  switch (args.action) {
    case "scan": {
      const input: ScanInput = {
        ...(args.systemId !== undefined ? { systemId: args.systemId } : {}),
        ...(args.deployUnit !== undefined ? { deployUnit: args.deployUnit } : {}),
        ...(args.keyword !== undefined ? { keyword: args.keyword } : {}),
      }
      const out = await adapter.scan(input, ctx.abort)
      return { ...out, route: ROUTES.scan }
    }
    case "list": {
      const input: ListInput = { appId: args.appId! }
      const out = await adapter.list(input, ctx.abort)
      return { ...out, route: ROUTES.list }
    }
    case "fetch": {
      const input: FetchInput = { appId: args.appId!, endpointRefs: args.endpointRefs! }
      const out = await adapter.fetch(input, ctx.abort)
      return { ...out, route: ROUTES.fetch }
    }
    case "fetchAll": {
      const input: FetchAllInput = { appId: args.appId! }
      const out = await adapter.fetchAll(input, ctx.abort)
      return { ...out, route: ROUTES.fetchAll }
    }
  }
}