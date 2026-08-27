import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi" // testagent_change
import { RootHttpApi } from "../api"
import { Bus } from "@/bus" // testagent_change
import {
  ApiEnvVarsConfigInvalidError,
  EnvVarBatchCreatePayload,
  EnvVarBatchDeletePayload,
  EnvVarBatchQueryPayload,
  EnvVarBatchUpdatePayload,
  TestagentUserPayload,
  ZhAnswerTogglePayload, // testagent_change
  ZhAnswerToggled, // testagent_change
} from "../groups/testagent" // testagent_change
import type { StoredToken } from "@/external-auth"
import { EnvVarsConfigInvalidError } from "@/testagent/env-vars" // testagent_change

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
      User.set({ userId, userName, sapId, openId, originPathId, pathName, token })
      const { EnvVars } = yield* Effect.promise(() => import("@/testagent/env-vars"))
      yield* Effect.promise(() => EnvVars.syncToProcessEnv())

      if (token && userId && userName && sapId) {
        const existingToken = yield* Effect.promise(() => ExternalAuth.getToken())
        if (!existingToken) {
          log.info("Saving testagent token to local file")
          yield* Effect.promise(() => ExternalAuth.saveToken(ctx.payload as StoredToken))
        }
      }

      return true
    })

    // testagent_change start
    const mapEnvVarsError = (error: unknown) => {
      if (error instanceof EnvVarsConfigInvalidError) {
        return new ApiEnvVarsConfigInvalidError({
          name: "EnvVarsConfigInvalidError",
          data: {
            message: error.message,
            invalidEntries: error.invalidEntries,
          },
        })
      }
      return new HttpApiError.InternalServerError({})
    }

    const envVarsList = Effect.fn("TestagentHttpApi.envVarsList")(function* () {
      const { EnvVars } = yield* Effect.promise(() => import("@/testagent/env-vars"))
      return yield* Effect.tryPromise({
        try: () => EnvVars.getAll(),
        catch: mapEnvVarsError,
      })
    })

    const envVarBatchQuery = Effect.fn("TestagentHttpApi.envVarBatchQuery")(function* (ctx: {
      payload: typeof EnvVarBatchQueryPayload.Type
    }) {
      const { EnvVars } = yield* Effect.promise(() => import("@/testagent/env-vars"))
      return yield* Effect.tryPromise({
        try: () => EnvVars.query([...ctx.payload]),
        catch: mapEnvVarsError,
      })
    })
    // testagent_change end

    const customEnvVarBatchCreate = Effect.fn("TestagentHttpApi.customEnvVarBatchCreate")(function* (ctx: {
      payload: typeof EnvVarBatchCreatePayload.Type
    }) {
      const { EnvVars } = yield* Effect.promise(() => import("@/testagent/env-vars"))
      const result = yield* Effect.promise(() => EnvVars.batchCreate(ctx.payload.map(item => ({ ...item }))))
      if (result.successKeys.length > 0) {
        yield* Effect.promise(() => EnvVars.syncToProcessEnv())
        log.info("Batch create custom env vars and synced to process.env", { 
          success: result.successKeys.length, 
          failed: result.failedKeys.length 
        })
      }
      return result
    })

    const customEnvVarBatchUpdate = Effect.fn("TestagentHttpApi.customEnvVarBatchUpdate")(function* (ctx: {
      payload: typeof EnvVarBatchUpdatePayload.Type
    }) {
      const { EnvVars } = yield* Effect.promise(() => import("@/testagent/env-vars"))
      const result = yield* Effect.promise(() => EnvVars.batchUpdate(ctx.payload.map(item => ({ ...item }))))
      if (result.successKeys.length > 0) {
        yield* Effect.promise(() => EnvVars.syncToProcessEnv())
        log.info("Batch update custom env vars and synced to process.env", { 
          success: result.successKeys.length, 
          failed: result.failedKeys.length 
        })
      }
      return result
    })

    const customEnvVarBatchDelete = Effect.fn("TestagentHttpApi.customEnvVarBatchDelete")(function* (ctx: {
      payload: typeof EnvVarBatchDeletePayload.Type
    }) {
      const { EnvVars } = yield* Effect.promise(() => import("@/testagent/env-vars"))
      yield* Effect.promise(() => EnvVars.batchDelete([...ctx.payload]))
      yield* Effect.promise(() => EnvVars.syncToProcessEnv())
      log.info("Batch delete custom env vars and synced to process.env", { keys: ctx.payload.length })
      return true
    })

    // testagent_change start - zh-answer toggle endpoint
    const ZH_ANSWER_ENV_KEY = "TESTAGENT_ZH_ANSWER_ENABLED"

    const zhAnswerSet = Effect.fn("TestagentHttpApi.zhAnswerSet")(function* (ctx: {
      payload: typeof ZhAnswerTogglePayload.Type
    }) {
      const enabled = ctx.payload.enabled
      const { EnvVars } = yield* Effect.promise(() => import("@/testagent/env-vars"))

      // 持久化开关状态（系统注入的标记不写自定义存储，云端重启后仍默认开启）
      yield* Effect.promise(async () => {
        try {
          const groups = await EnvVars.query([ZH_ANSWER_ENV_KEY])
          if (!groups.system[ZH_ANSWER_ENV_KEY]) {
            const entry = { key: ZH_ANSWER_ENV_KEY, value: enabled ? "1" : "0" }
            if (groups.custom[ZH_ANSWER_ENV_KEY]) await EnvVars.batchUpdate([entry])
            else await EnvVars.batchCreate([entry])
          }
          await EnvVars.syncToProcessEnv()
        } catch (err) {
          log.warn("failed to persist zh answer toggle", { error: String(err) })
        }
      })

      const bus = yield* Bus.Service
      yield* bus.publish(ZhAnswerToggled, { enabled })
      log.info("ZH answer toggled", { enabled })
      return true
    })
    // testagent_change end

    return handlers
      .handle("userSet", userSet)
      .handle("envVarsList", envVarsList)
      .handle("envVarBatchQuery", envVarBatchQuery)
      .handle("customEnvVarBatchCreate", customEnvVarBatchCreate)
      .handle("customEnvVarBatchUpdate", customEnvVarBatchUpdate)
      .handle("customEnvVarBatchDelete", customEnvVarBatchDelete)
      .handle("zhAnswerSet", zhAnswerSet) // testagent_change
  }),
)
