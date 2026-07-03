import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/config"

const Scope = Schema.Literals(["global", "project"])
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)

export const ConfigOverlayPatch = Schema.Struct({
  scope: Schema.optional(Scope),
  set: Schema.optional(UnknownRecord),
  unset: Schema.optional(Schema.Array(Schema.Array(Schema.String))),
})

export const ConfigOverlayResponse = Schema.Struct({
  project: Config.Info,
}).annotate({ identifier: "ConfigOverlayResponse" })

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          success: described(Config.Info, "Get config info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Get configuration",
            description: "Retrieve the current OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          payload: Config.Info,
          success: described(Config.Info, "Successfully updated config"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Update configuration",
            description: "Update OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.get("overlay", `${root}/overlay`, {
          success: described(ConfigOverlayResponse, "Project config overlay"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.overlay",
            summary: "Get config overlay",
            description: "Retrieve the raw project-level config overlay for scope-aware settings editing.",
          }),
        ),
        HttpApiEndpoint.patch("overlayUpdate", `${root}/overlay`, {
          payload: ConfigOverlayPatch,
          success: described(Config.Info, "Effective configuration after patch"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.overlayUpdate",
            summary: "Patch config overlay",
            description: "Apply a minimal global or project config patch, including unset paths for reverting local overrides.",
          }),
        ),
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          success: described(Provider.ConfigProvidersResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Experimental HttpApi config routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
