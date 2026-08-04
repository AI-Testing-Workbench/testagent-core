export * as ConfigAgent from "./agent"

import { Effect, Exit, Layer, ManagedRuntime, Schema, SchemaGetter } from "effect"
import { zod } from "@/util/effect-zod"
import { PositiveInt, withStatics } from "@/util/schema"
import * as Log from "@opencode-ai/core/util/log"
import { Glob } from "@opencode-ai/core/util/glob"
import { Observability } from "@opencode-ai/core/effect/observability"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"
import { ConfigModelID } from "./model-id"
import { ConfigParse } from "./parse"
import { ConfigPermission } from "./permission"

let otelRt: ManagedRuntime.ManagedRuntime<never, never> | undefined
const getOtelRt = () => {
  if (!otelRt) otelRt = ManagedRuntime.make(Observability.layer as Layer.Layer<never, never>, { memoMap })
  return otelRt
}

const log = Log.create({ service: "config" })

const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

const AgentSchema = Schema.StructWithRest(
  Schema.Struct({
    model: Schema.optional(Schema.NullOr(ConfigModelID)),
    variant: Schema.optional(Schema.NullOr(Schema.String)).annotate({
      description: "Default model variant for this agent (applies only when using the agent's configured model).",
    }),
    temperature: Schema.optional(Schema.NullOr(Schema.Finite)),
    top_p: Schema.optional(Schema.NullOr(Schema.Finite)),
    prompt: Schema.optional(Schema.NullOr(Schema.String)),
    tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
      description: "@deprecated Use 'permission' field instead",
    }),
    disable: Schema.optional(Schema.Boolean),
    description: Schema.optional(Schema.NullOr(Schema.String)).annotate({
      description: "Description of when to use the agent",
    }),
    mode: Schema.optional(Schema.Literals(["subagent", "primary", "all"])),
    hidden: Schema.optional(Schema.Boolean).annotate({
      description: "Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)",
    }),
    // testagent_change start - preserve plugin provider options that use the same key
    thinking: Schema.optional(Schema.Union([Schema.Boolean, Schema.Record(Schema.String, Schema.Any)])).annotate({
      description: "Enable agent thinking with a boolean, or pass provider-specific thinking options.",
    }),
    // testagent_change end
    options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
    color: Schema.optional(Color).annotate({
      description: "Hex color code (e.g., #FF5733) or theme color (e.g., primary)",
    }),
    steps: Schema.optional(Schema.NullOr(PositiveInt)).annotate({
      description: "Maximum number of agentic iterations before forcing text-only response",
    }),
    maxSteps: Schema.optional(PositiveInt).annotate({ description: "@deprecated Use 'steps' field instead." }),
    permission: Schema.optional(ConfigPermission.Info),
  }),
  [Schema.Record(Schema.String, Schema.Any)],
)

const KNOWN_KEYS = new Set([
  "name",
  "model",
  "variant",
  "prompt",
  "description",
  "temperature",
  "top_p",
  "mode",
  "hidden",
  "thinking", // testagent_change
  "color",
  "steps",
  "maxSteps",
  "options",
  "permission",
  "disable",
  "tools",
])

// Post-parse normalisation:
//  - Promote any unknown-but-present keys into `options` so they survive the
//    round-trip in a well-known field.
//  - Translate the deprecated `tools: { name: boolean }` map into the new
//    `permission` shape (write-adjacent tools collapse into `permission.edit`).
//  - Coalesce `steps ?? maxSteps` so downstream can ignore the deprecated alias.
const normalize = (agent: Schema.Schema.Type<typeof AgentSchema>): Schema.Schema.Type<typeof AgentSchema> => {
  const options: Record<string, unknown> = { ...agent.options }
  for (const [key, value] of Object.entries(agent)) {
    if (!KNOWN_KEYS.has(key)) options[key] = value
  }
  // testagent_change - object form belongs to provider options; boolean remains the agent toggle
  if (agent.thinking !== undefined && typeof agent.thinking !== "boolean") options.thinking = agent.thinking

  const permission: ConfigPermission.Info = {}
  for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
    const action = enabled ? "allow" : "deny"
    if (tool === "write" || tool === "edit" || tool === "patch") {
      permission.edit = action
      continue
    }
    permission[tool] = action
  }
  globalThis.Object.assign(permission, agent.permission)

  const steps = agent.steps ?? agent.maxSteps
  return {
    ...agent,
    options,
    permission,
    thinking: typeof agent.thinking === "boolean" ? agent.thinking : undefined,
    ...(steps !== undefined ? { steps } : {}),
  }
}

export const Info = AgentSchema.pipe(
  Schema.decodeTo(AgentSchema, {
    decode: SchemaGetter.transform(normalize),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)
  .annotate({ identifier: "AgentConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export async function load(dir: string) {
  const result: Record<string, Info> = {}
  for (const item of await Glob.scan("{agent,agents}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    // testagent_change start - let parse errors propagate to warnings
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue
    // testagent_change end

    const patterns = [
      "/.opencode/agent/",
      "/.opencode/agents/",
      "/.testagent/agent/",
      "/.testagent/agents/",
      "/agent/",
      "/agents/",
    ] // testagent_change
    const name = configEntryNameFromPath(item, patterns)

    const config = {
      name,
      ...md.data,
      prompt: md.content.trim(),
    }
    result[config.name] = ConfigParse.effectSchema(Info, config, item)
  }
  return result
}

export async function loadMode(dir: string) {
  const result: Record<string, Info> = {}
  for (const item of await Glob.scan("{mode,modes}/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    // testagent_change start - let parse errors propagate to warnings, use effectSchema instead of silent skip
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const config = {
      name: configEntryNameFromPath(item, []),
      ...md.data,
      prompt: md.content.trim(),
    }
    try {
      const parsed = ConfigParse.effectSchema(Info, config, item)
      result[config.name] = {
        ...parsed,
        mode: "primary" as const,
      }
    } catch (err) {
      log.error("模式配置校验失败", { mode: item, err })
      getOtelRt().runFork(Effect.logError("模式配置校验失败", { mode: item, err }))
      throw err
    }
    // testagent_change end
  }
  return result
}
