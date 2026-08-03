// testagent_change - new file
// Plugin allowlist filtering: fetches an external API to determine which plugins should be loaded.
// When the API returns enabled=true, only plugins whose names appear in allowedPlugins will load.
// Local plugins (scope=local) are always blocked when filtering is active, with reasons displayed.

import { ConfigPlugin } from "@/config/plugin"
import { isPathPluginSpec } from "@/plugin/shared"
import { base64Decode } from "@opencode-ai/core/util/encode"

// Base64-encoded default allowlist endpoint; override with TESTAGENT_PLUGIN_ALLOWLIST_URL.
const encodedUrl = "aHR0cHM6Ly90ZXN0aHViLWdhdGV3YXkucGFhcy5jbWJjaGluYS5jbi90ZXN0YWdlbnQtcGx1Z2luL3JlZ2lzdGVyZWQtbGlzdA=="

export type PluginAllowlist = {
  enabled: boolean
  allowedPlugins: string[]
}

// Raw API envelope returned by the allowlist endpoint.
type AllowlistResponse = {
  returnCode: string
  errorMsg?: string
  body: {
    pluginNames: string[]
    enabled: boolean
  }
}

// Fetch the plugin allowlist from an external API.
// When the endpoint fails (network error, non-ok status, timeout, business error),
// filtering is skipped entirely (enabled=false) so no plugins are accidentally blocked.
async function fetchAllowlist(): Promise<PluginAllowlist> {
  const url = process.env["TESTAGENT_PLUGIN_ALLOWLIST_URL"] || base64Decode(encodedUrl)

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) {
      return { enabled: false, allowedPlugins: [] }
    }
    const data = (await res.json()) as AllowlistResponse
    if (data.returnCode !== "SUC0000") {
      return { enabled: false, allowedPlugins: [] }
    }
    const result: PluginAllowlist = {
      enabled: data.body?.enabled ?? false,
      allowedPlugins: data.body?.pluginNames ?? [],
    }
    return result
  } catch (err) {
    return { enabled: false, allowedPlugins: [] }
  }
}

// Extract a plugin name from a spec string for allowlist matching.
// For file URLs/paths the base name (without extension) is used; for npm specs the package name is used.
function pluginName(spec: string): string {
  // file:// URLs or absolute paths
  if (spec.startsWith("file://") || spec.startsWith("/") || /^[A-Za-z]:[\\/]/.test(spec)) {
    const base = spec.replace(/^file:\/\//, "").replace(/\\/g, "/")
    const name = base.split("/").pop() ?? base
    return name.replace(/\.(ts|js|mjs|cjs|tsx|jsx)$/, "")
  }
  // npm package spec: "pkg", "@scope/pkg", "pkg@version", "@scope/pkg@version"
  const at = spec.indexOf("@", 1)
  const slash = spec.indexOf("/")
  if (slash > 0 && (at < 0 || at > slash)) {
    // scoped package: @scope/pkg...
    const rest = spec.slice(slash + 1)
    const ver = rest.indexOf("@")
    return ver > 0 ? `@${spec.slice(1, slash)}/${rest.slice(0, ver)}` : `@${spec.slice(1, slash)}/${rest}`
  }
  const ver = spec.indexOf("@", 1)
  return ver > 0 ? spec.slice(0, ver) : spec
}

// A plugin that was filtered out by the allowlist.
export type FilteredPlugin = {
  spec: string
  name: string
  reason: string
}

// Result of filtering: plugins allowed to load + plugins that were filtered out with reasons.
export type FilterResult = {
  allowed: ConfigPlugin.Origin[]
  filtered: FilteredPlugin[]
}

// Filter plugin origins based on the external allowlist and local plugin policy.
// When plugin_debug is true, ALL plugins pass through without filtering.
// When filtering is active:
//   - All local-scope plugins (scope === "local") are blocked with a reason
//   - Remaining (global) plugins are checked against the allowlist
export async function filterPluginOrigins(
  origins: ConfigPlugin.Origin[],
  pluginDebug = false,
): Promise<FilterResult> {
  if (!origins.length) return { allowed: origins, filtered: [] }

  // plugin_debug=true: skip all filtering
  if (pluginDebug) {
    return { allowed: origins, filtered: [] }
  }

  const allowlist = await fetchAllowlist()
  if (!allowlist.enabled) {
    return { allowed: origins, filtered: [] }
  }

  const allowedNames = new Set(allowlist.allowedPlugins.map((n) => n.toLowerCase()))
  const allowed: ConfigPlugin.Origin[] = []
  const filtered: FilteredPlugin[] = []

  for (const origin of origins) {
    const spec = ConfigPlugin.pluginSpecifier(origin.spec)
    const name = pluginName(spec)

    // Local file plugins (path-based specs like file://, ./plugins/foo.ts, /absolute/path) are always blocked
    // when filtering is active. npm plugins (@scope/pkg, some-package) are checked against the allowlist.
    if (isPathPluginSpec(spec)) {
      filtered.push({
        spec,
        name,
        reason: "本地插件不允许加载",
      })
      continue
    }

    // Global plugins: check against the allowlist
    if (allowedNames.has(name.toLowerCase())) {
      allowed.push(origin)
    } else {
      filtered.push({
        spec,
        name,
        reason: `插件未在注册列表中，请先去测小智市场注册`,
      })
    }
  }

  return { allowed, filtered }
}