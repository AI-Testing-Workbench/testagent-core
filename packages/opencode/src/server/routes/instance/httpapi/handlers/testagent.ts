import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { TestagentUserPayload } from "../groups/testagent"
import type { StoredToken } from "@/external-auth"

const log = Log.create({ service: "server" })

export const testagentHandlers = HttpApiBuilder.group(RootHttpApi, "testagent", (handlers) =>
  Effect.gen(function* () {
    const userSet = Effect.fn("TestagentHttpApi.userSet")(function* (ctx: {
      payload: typeof TestagentUserPayload.Type
    }) {
      const { User } = yield* Effect.promise(() => import("@/testagent/user"))
      const { ExternalAuth } = yield* Effect.promise(() => import("@/external-auth"))

      const { userId, userName, sapId, token, openId, originPathId, pathName } = ctx.payload

      log.info("Setting testagent user info", { userId, userName, sapId, hasToken: !!token })
      User.set({ userId, userName, sapId, openId, originPathId, pathName })

      if (token && userId && userName && sapId) {
        const existingToken = yield* Effect.promise(() => ExternalAuth.getToken())
        if (!existingToken) {
          log.info("Saving testagent token to local file")
          yield* Effect.promise(() => ExternalAuth.saveToken(ctx.payload as StoredToken))
        }
      }

      return true
    })

    return handlers.handle("userSet", userSet)
  }),
)
