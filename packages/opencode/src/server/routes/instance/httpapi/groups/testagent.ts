import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi" // testagent_change
import { BusEvent } from "@/bus/bus-event" // testagent_change
import { described } from "./metadata"

// testagent_change start - zh-answer toggle bus event
export const ZhAnswerToggled = BusEvent.define(
  "zh.answer.toggled",
  Schema.Struct({
    enabled: Schema.Boolean,
  }),
)
// testagent_change end

export const ZhAnswerTogglePayload = Schema.Struct({
  enabled: Schema.Boolean,
})

export const TestagentUserPayload = Schema.Struct({
  token: Schema.optional(Schema.String),
  userId: Schema.optional(Schema.String),
  userName: Schema.optional(Schema.String),
  employeeId: Schema.optional(Schema.String),
  enterpriseId: Schema.optional(Schema.String),
  enterpriseName: Schema.optional(Schema.String),
  idToken: Schema.optional(Schema.String),
  joinedEnterpriseIds: Schema.optional(Schema.String),
  netEnv: Schema.optional(Schema.String),
  openId: Schema.optional(Schema.String),
  originPathId: Schema.optional(Schema.String),
  pathId: Schema.optional(Schema.String),
  pathName: Schema.optional(Schema.String),
  refreshToken: Schema.optional(Schema.String),
  rtcId: Schema.optional(Schema.String),
  sapId: Schema.optional(Schema.String),
  ystId: Schema.optional(Schema.String),
})

const EnvVarKey = Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/))

const EnvVarValue = Schema.String.check(Schema.isMinLength(1))

export const EnvVarItem = Schema.Struct({
  key: EnvVarKey,
  value: EnvVarValue,
})

export const EnvVarGroups = Schema.Struct({
  system: Schema.Record(Schema.String, EnvVarItem),
  custom: Schema.Record(Schema.String, EnvVarItem),
})

// testagent_change start
export const EnvVarSetPayload = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
})
// testagent_change end

export const EnvVarBatchCreatePayload = Schema.Array(EnvVarSetPayload)

export const EnvVarBatchUpdatePayload = Schema.Array(EnvVarSetPayload)

export const EnvVarBatchDeletePayload = Schema.Array(EnvVarKey)

export const EnvVarBatchQueryPayload = Schema.Array(EnvVarKey)

export const EnvVarInvalidEntry = Schema.Struct({
  key: Schema.String,
  message: Schema.String,
})

export class ApiEnvVarsConfigInvalidError extends Schema.ErrorClass<ApiEnvVarsConfigInvalidError>("EnvVarsConfigInvalidError")(
  {
    name: Schema.Literal("EnvVarsConfigInvalidError"),
    data: Schema.Struct({
      message: Schema.String,
      invalidEntries: Schema.Array(EnvVarInvalidEntry),
    }),
  },
  { httpApiStatus: 422 },
) {}

// testagent_change start
export const EnvVarBatchResponse = Schema.Struct({
  successKeys: Schema.Array(Schema.String),
  failedKeys: Schema.Array(Schema.String),
  failedEntries: Schema.Array(EnvVarInvalidEntry),
})
// testagent_change end

export const TestagentPaths = {
  userSet: "/testagent/user",
  envVarsList: "/testagent/env-vars",
  envVarBatchQuery: "/testagent/env-vars/query",
  envVarsCustomCreate: "/testagent/env-vars/custom",
  envVarsCustomUpdate: "/testagent/env-vars/custom",
  envVarsCustomDelete: "/testagent/env-vars/custom",
  zhAnswerSet: "/testagent/zh-answer", // testagent_change
} as const

export const TestagentApi = HttpApi.make("testagent").add(
  HttpApiGroup.make("testagent")
    .add(
      HttpApiEndpoint.put("userSet", TestagentPaths.userSet, {
        payload: TestagentUserPayload,
        success: described(Schema.Boolean, "User info set successfully"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "testagent.user.set",
          summary: "Set testagent user info",
          description: "Set the current testagent user information and optionally save authentication token.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("envVarsList", TestagentPaths.envVarsList, {
        success: described(EnvVarGroups, "按来源分组的环境变量列表"),
        error: [ApiEnvVarsConfigInvalidError, HttpApiError.InternalServerError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "testagent.envVars.list",
          summary: "Get environment variables",
          description: "Get system auto-injected and custom environment variables separately.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("envVarBatchQuery", TestagentPaths.envVarBatchQuery, {
        payload: EnvVarBatchQueryPayload,
        success: described(EnvVarGroups, "按来源分组的查询结果"),
        error: [ApiEnvVarsConfigInvalidError, HttpApiError.InternalServerError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "testagent.envVars.batchQuery",
          summary: "Query environment variables by keys",
          description: "Query environment variables by a list of keys. Returns system and custom groups with only matching keys.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("customEnvVarBatchCreate", TestagentPaths.envVarsCustomCreate, {
        payload: EnvVarBatchCreatePayload,
        success: described(EnvVarBatchResponse, "批量创建结果"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "testagent.customEnvVars.batchCreate",
          summary: "Batch create custom environment variables",
          description: "Create multiple custom environment variables. Only non-existing keys with valid format will succeed.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.put("customEnvVarBatchUpdate", TestagentPaths.envVarsCustomUpdate, {
        payload: EnvVarBatchUpdatePayload,
        success: described(EnvVarBatchResponse, "批量更新结果"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "testagent.customEnvVars.batchUpdate",
          summary: "Batch update custom environment variables",
          description: "Update multiple custom environment variables. Only existing custom keys with valid format will succeed.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("customEnvVarBatchDelete", TestagentPaths.envVarsCustomDelete, {
        payload: EnvVarBatchDeletePayload,
        success: described(Schema.Boolean, "批量删除成功"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "testagent.customEnvVars.batchDelete",
          summary: "Batch delete custom environment variables",
          description: "Delete multiple custom environment variables. Non-existing keys are ignored.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("zhAnswerSet", TestagentPaths.zhAnswerSet, {
        payload: ZhAnswerTogglePayload,
        success: described(Schema.Boolean, "ZH answer toggle set successfully"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "testagent.zhAnswer.set",
          summary: "Toggle ZH answer bridging",
          description: "Enable or disable bridging of permission/question asks to enterprise ZH via relay.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "testagent",
        description: "Testagent integration routes.",
      }),
    ),
)
