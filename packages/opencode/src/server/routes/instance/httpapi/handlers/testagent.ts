import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { TestagentUserPayload } from "../groups/testagent"

const log = Log.create({ service: "server" })

export const testagentHandlers = HttpApiBuilder.group(RootHttpApi, "testagent", (handlers) =>
  Effect.gen(function* () {
    const userSet = Effect.fn("TestagentHttpApi.userSet")(function* (ctx: {
      payload: typeof TestagentUserPayload.Type
    }) {
      const { User } = yield* Effect.promise(() => import("@/testagent/user"))
      const { ExternalAuth } = yield* Effect.promise(() => import("@/external-auth"))

      const { id, name, token } = ctx.payload

      log.info("Setting testagent user info", { id, name, hasToken: !!token })
      User.set({ id, name })

      if (token && id && name) {
        const existingToken = yield* Effect.promise(() => ExternalAuth.getToken())
        if (!existingToken) {
          log.info("Saving testagent token to local file")
          yield* Effect.promise(() => ExternalAuth.saveToken({ userId: id, userName: name, token }))
        }
      }

      return true
    })

    return handlers.handle("userSet", userSet)
  }),
)
