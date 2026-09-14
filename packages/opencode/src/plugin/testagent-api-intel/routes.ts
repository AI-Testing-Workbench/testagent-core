// testagent_change - dispatch for the api_intel tool. First-stage supports
// only the apicol platform (API 协作平台). FTC/FA are intentionally omitted.

import type { ToolContext } from "@opencode-ai/plugin"
import { ApicolAdapter, type FetchAllInput, type FetchInput, type ListInput, type ScanInput } from "./platforms/apicol"

export const ROUTES = {
  scan: "POST apicol.scan",
  list: "POST apicol.list",
  fetch: "POST apicol.fetch",
  fetchAll: "POST apicol.fetchAll",
} as const

export type Action = "scan" | "list" | "fetch" | "fetchAll"

export type ApiIntelArgs = {
  action: Action
  platform: "apicol"
  systemId?: string
  deployUnit?: string
  keyword?: string
  appId?: string
  endpointRefs?: string[]
}

function need(args: ApiIntelArgs, key: keyof ApiIntelArgs): string | null {
  const v = args[key]
  if (v === undefined || v === null || v === "") return `action="${args.action}" requires "${key}"`
  return null
}

export function validate(args: ApiIntelArgs): void {
  switch (args.action) {
    case "scan":
      if (args.platform !== "apicol") {
        throw new Error(`action="scan" requires platform="apicol"`)
      }
      return
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