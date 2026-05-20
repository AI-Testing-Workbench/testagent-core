import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

export const TestagentUserPayload = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
})

export const TestagentPaths = {
  userSet: "/kilocode/testagent/user",
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
