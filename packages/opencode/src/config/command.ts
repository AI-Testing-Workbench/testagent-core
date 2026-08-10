export * as ConfigCommand from "./command"

import * as Log from "@opencode-ai/core/util/log"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { Glob } from "@opencode-ai/core/util/glob"
import { Bus } from "@/bus"
import { Observability } from "@opencode-ai/core/effect/observability"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { configEntryNameFromPath } from "./entry-name"
import { InvalidError } from "./error"
import * as ConfigMarkdown from "./markdown"
import { ConfigParse } from "./parse" // testagent_change
import { ConfigModelID } from "./model-id"

let otelRt: ManagedRuntime.ManagedRuntime<never, never> | undefined
const getOtelRt = () => {
  if (!otelRt) otelRt = ManagedRuntime.make(Observability.layer as Layer.Layer<never, never>, { memoMap })
  return otelRt
}

const log = Log.create({ service: "config" })

export const Info = Schema.Struct({
  template: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(ConfigModelID),
  subtask: Schema.optional(Schema.Boolean),
  mode: Schema.optional(Schema.String),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Schema.Schema.Type<typeof Info>

export async function load(dir: string) {
  const result: Record<string, Info> = {}
  for (const item of await Glob.scan("{command,commands}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const patterns = [
      "/.opencode/command/",
      "/.opencode/commands/",
      "/.testagent/command/",
      "/.testagent/commands/",
      "/command/",
      "/commands/",
    ] // testagent_change
    const name = configEntryNameFromPath(item, patterns)

    const config = {
      name,
      ...md.data,
      template: md.content.trim(),
    }
    // testagent_change start - throw InvalidError so errors propagate to warnings
    try {
      // Remove `name` before validation — it's only used as the result key,
      // not part of the Info schema (which doesn't include `name`).
      const { name: _name, ...rest } = config
      result[config.name] = ConfigParse.effectSchema(Info, rest, item)
    } catch (err) {
      const issues = err instanceof InvalidError ? err.data.issues : undefined
      log.error("命令校验失败", { command: item, issues })
      getOtelRt().runFork(Effect.logError("命令校验失败", { command: item, issues }))
      throw err
    }
    // testagent_change end
  }
  return result
}
