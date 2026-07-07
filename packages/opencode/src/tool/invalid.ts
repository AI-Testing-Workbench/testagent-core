import { Effect, Metric, Schema } from "effect"
import * as Tool from "./tool"
import { Session } from "@/session/session"
import { failInvalidArgs } from "@opencode-ai/core/effect/observability" // testagent_change

export const Parameters = Schema.Struct({
  tool: Schema.String,
  error: Schema.String,
})

export const InvalidTool = Tool.define(
  "invalid",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description: "Do not use",
      parameters: Parameters,
      execute: (params: { tool: string; error: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const sid = yield* sessions.get(ctx.sessionID)
          yield* Metric.update(Metric.withAttributes(failInvalidArgs, { session_id: ctx.sessionID, modelID: sid.model?.id ?? "", providerID: sid.model?.providerID ?? "" }), 1)
          return {
            title: "Invalid Tool",
            output: `The arguments provided to the tool are invalid: ${params.error}`,
            metadata: {},
          }
        }),
    } as Tool.DefWithoutID<typeof Parameters>
  }),
)
