export * as ConfigCommand from "./command"

import * as Log from "@opencode-ai/core/util/log"
import { Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import { Glob } from "@opencode-ai/core/util/glob"
import { Bus } from "@/bus"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { configEntryNameFromPath } from "./entry-name"
import { InvalidError } from "./error"
import * as ConfigMarkdown from "./markdown"
import { ConfigModelID } from "./model-id"

const log = Log.create({ service: "config" })

export const Info = Schema.Struct({
  template: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(ConfigModelID),
  subtask: Schema.optional(Schema.Boolean),
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
    const md = await ConfigMarkdown.parse(item).catch(async (err) => {
      const message = ConfigMarkdown.FrontmatterError.isInstance(err)
        ? err.data.message
        : `Failed to parse command ${item}`
      const { Session } = await import("@/session/session")
      void Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
      log.error("failed to load command", { command: item, err })
      return undefined
    })
    if (!md) continue

    const patterns = ["/.opencode/command/", "/.opencode/commands/", "/.testagent/command/", "/.testagent/commands/", "/command/", "/commands/"] // testagent_change
    const name = configEntryNameFromPath(item, patterns)

    const config = {
      name,
      ...md.data,
      template: md.content.trim(),
    }
    const parsed = Info.zod.safeParse(config)
    if (parsed.success) {
      result[config.name] = parsed.data
      continue
    }
    // testagent_change start - don't throw, just log and skip invalid commands
    const error = new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    log.error("failed to validate command", { command: item, issues: parsed.error.issues })
    const { Session } = await import("@/session/session")
    void Bus.publish(Session.Event.Error, { 
      error: new NamedError.Unknown({ 
        message: `Command validation failed: ${item}\n${parsed.error.issues.map(i => `- ${i.path.join(".")}: ${i.message}`).join("\n")}` 
      }).toObject() 
    })
    // Skip this command and continue with others
    continue
    // testagent_change end
  }
  return result
}
