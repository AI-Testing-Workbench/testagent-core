import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: Config.Info; model: Provider.Model }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  const base = input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model))

  // testagent_change start - threshold_percent support
  // threshold_percent only applies when auto compaction is enabled
  const percent = input.cfg.compaction?.threshold_percent
  if (input.cfg.compaction?.auto !== false && typeof percent === "number") {
    const win = input.model.limit.input || context
    const cap = Math.floor(win * (percent / 100))
    return Math.min(base, cap)
  }
  // testagent_change end

  return base
}

export function isOverflow(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  if (input.model.limit.context === 0) return false

  // testagent_change start - force compaction support
  if (input.cfg.compaction?.auto === false && !(input.cfg.compaction?.force ?? false)) return false
  // testagent_change end

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
