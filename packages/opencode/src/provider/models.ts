import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
// testagent_change - removed HttpClient imports, using native fetch
// import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
// import { Installation } from "../installation"
import { Flag } from "@opencode-ai/core/flag/flag"
// testagent_change - removed Flock and Hash, not needed for local-only cache
// import { Flock } from "@opencode-ai/core/util/flock"
// import { Hash } from "@opencode-ai/core/util/hash"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
// testagent_change - removed withTransientReadRetry, not needed
// import { withTransientReadRetry } from "@/util/effect-http-client"
import { User } from "../testagent/user" // testagent_change
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "models fetch" })


const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean,
  tool_call: Schema.Boolean,
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(Schema.Literals(["alpha", "beta", "deprecated"])),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

export type Provider = Schema.Schema.Type<typeof Provider>

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelsDev") {}

// testagent_change - layer only needs AppFileSystem, no HttpClient needed
export const layer: Layer.Layer<Service, never, AppFileSystem.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    // testagent_change - http client not needed, no remote fetch
    // const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))

    // testagent_change - simplified filepath, no hash needed
    const filepath = path.join(Global.Path.cache, "models.json")
    // testagent_change - no ttl/lockKey needed for local-only cache
    // const ttl = Duration.minutes(5)
    // const lockKey = `models-dev:${filepath}`

    // testagent_change - fresh/fetchApi/fetchAndWrite not needed for local-only cache
    // const fresh = Effect.fnUntraced(function* () { ... })
    // const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* () { ... })
    // const fetchAndWrite = Effect.fn("ModelsDev.fetchAndWrite")(function* () { ... })

    const loadFromDisk = fs.readJson(Flag.OPENCODE_MODELS_PATH ?? filepath).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.map((v) => v as Record<string, Provider> | undefined),
    )

    // testagent_change - no snapshot loading needed
    // const loadSnapshot = Effect.tryPromise({ ... })

    // testagent_change start - only read from local cache, no remote fetch
    const populate = Effect.gen(function* () {
      const fromDisk = yield* loadFromDisk
      if (fromDisk) return fromDisk
      // testagent_change - no bundled snapshot, users must configure models manually
      return {}
    }).pipe(Effect.withSpan("ModelsDev.populate"), Effect.orDie)
    // testagent_change end

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity)

    // testagent_change start - fetch test-llm models helper
    const fetchTestLLMModels = Effect.fn("ModelsDev.fetchTestLLMModels")(function* () {
      const apiKey = process.env.TEST_LLM_API_KEY ?? "sk-WHMJMG6H36UGdq7FdVzODA"
      const baseURL = (process.env.TEST_LLM_BASE_URL ?? "http://test-llm.platform.cmbchina.cn/v1").replace(/\/+$/, "")
      const userId = User.get().id ?? ""
      const url = `${baseURL}/models?user_id=${encodeURIComponent(userId)}`
      
      log.info("[testagent] fetchTestLLMModels:", { url, userId, baseURL })
      // testagent_change - use native fetch instead of Effect HttpClient
      const response = yield* Effect.tryPromise({
        try: () => fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        }),
        catch: (error) => error,
      })
      
      if (!response.ok) {
        throw new Error(`test-llm /models returned HTTP ${response.status}`)
      }
      
      const json = (yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (error) => error,
      })) as { data?: Array<{ id: string; owned_by?: string }> }
      
      const result: Record<string, Model> = {}
      
      for (const item of json.data ?? []) {
        if (!item.id) continue
        result[item.id] = {
          id: item.id,
          name: item.id,
          family: item.owned_by ?? "test-llm",
          release_date: "",
          attachment: false,
          reasoning: item.id.includes("reasoner"),
          temperature: true,
          tool_call: true,
          cost: { input: 0, output: 0 },
          limit: { context: 64000, output: 0 },
          modalities: {
            input: ["text"],
            output: ["text"],
          },
        }
      }
      
      return result
    })
    // testagent_change end

    const get = (): Effect.Effect<Record<string, Provider>> => 
      // testagent_change start - inject test-llm provider dynamically every time
      Effect.gen(function* () {
        const providers = yield* cachedGet
        
        // Always check and inject test-llm if not present
        if (!providers["test-llm"]) {
          const models = yield* fetchTestLLMModels().pipe(
            Effect.catch((error) => {
              console.error("[testagent] test-llm model fetch failed:", error)
              return Effect.succeed({} as Record<string, Model>)
            }),
          )
          
          const mutableProviders = { ...providers } as Record<string, Provider>
          mutableProviders["test-llm"] = {
            id: "test-llm",
            name: "Test LLM",
            env: ["TEST_LLM_API_KEY"],
            api: "http://test-llm.platform.cmbchina.cn/v1",
            npm: "@ai-sdk/openai-compatible",
            models,
          }
          return mutableProviders
        }
        
        return providers
      })
      // testagent_change end

    // testagent_change start - refresh disabled, models come from local cache only
    const refresh = Effect.fn("ModelsDev.refresh")(function* (_force = false) {
      // Remote fetch disabled — models come from local cache only
      return
    })
    // testagent_change end

    // testagent_change - no automatic refresh
    // if (!Flag.OPENCODE_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
    //   yield* Effect.forkScoped(refresh().pipe(Effect.repeat(Schedule.spaced("60 minutes")), Effect.ignore))
    // }

    return Service.of({ get, refresh })
  }),
)

// testagent_change - defaultLayer only needs AppFileSystem
export const defaultLayer: Layer.Layer<Service> = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as ModelsDev from "./models"
