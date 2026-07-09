import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

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

export const TestagentPaths = {
  userSet: "/testagent/user",
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
    .annotateMerge(
      OpenApi.annotations({
        title: "testagent",
        description: "Testagent integration routes.",
      }),
    ),
)
