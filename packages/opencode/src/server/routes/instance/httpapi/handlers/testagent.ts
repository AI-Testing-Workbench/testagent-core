import { Agent } from "@/agent/agent"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi" // testagent_change
import { RootHttpApi } from "../api"
import {
  AgentOverrideClearPayload,
  AgentOverridePayload,
  ApiEnvVarsConfigInvalidError,
  EnvVarBatchCreatePayload,
  EnvVarBatchDeletePayload,
  EnvVarBatchQueryPayload,
  EnvVarBatchUpdatePayload,
  TestagentUserPayload,
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

    // testagent_change start - per-stage subagent override handlers
    const agentOverrideSet = Effect.fn("TestagentHttpApi.agentOverrideSet")(function* (ctx: {
      payload: typeof AgentOverridePayload.Type
    }) {
      const agents = yield* Agent.Service
      return yield* agents.setSessionOverride({
        sessionID: ctx.payload.sessionID,
        prompt: ctx.payload.prompt,
        permission: ctx.payload.permission as any,
        temperature: ctx.payload.temperature,
        topP: ctx.payload.topP,
        steps: ctx.payload.steps,
      })
    })

    const agentOverrideClear = Effect.fn("TestagentHttpApi.agentOverrideClear")(function* (ctx: {
      payload: typeof AgentOverrideClearPayload.Type
    }) {
      const agents = yield* Agent.Service
      yield* agents.clearSessionOverride({ sessionID: ctx.payload.sessionID })
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
      .handle("agentOverrideSet", agentOverrideSet) // testagent_change
      .handle("agentOverrideClear", agentOverrideClear) // testagent_change
  }),
)
