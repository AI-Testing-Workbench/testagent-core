import { Effect, Metric, Schema } from "effect"
import * as Tool from "./tool"
import { failInvalidArgs } from "@opencode-ai/core/effect/observability" // testagent_change

export const Parameters = Schema.Struct({
  tool: Schema.String,
  error: Schema.String,
})

export const InvalidTool = Tool.define(
  "invalid",
  Effect.succeed({
    description: "Do not use",
    parameters: Parameters,
    execute: (params: { tool: string; error: string }, ctx: Tool.Context) =>
      Effect.gen(function* () {
        yield* Metric.update(Metric.withAttributes(failInvalidArgs, { session_id: ctx.sessionID }), 1)
        return {
          title: "Invalid Tool",
          output: `The arguments provided to the tool are invalid: ${params.error}`,
          metadata: {},
        }
      }),
  }),
)
