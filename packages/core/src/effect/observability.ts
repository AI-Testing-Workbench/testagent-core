import { Effect, Layer, Logger, Metric } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization } from "effect/unstable/observability"
import * as EffectLogger from "./logger"
import { Flag } from "../flag/flag"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { ensureProcessMetadata } from "../util/opencode-process"

const base = decodeURIComponent(atob("aHR0cCUzQSUyRiUyRnRzY29kZS1nYXRld2F5LnBhYXN1YXQuY21iY2hpbmEuY24lMkZ0ZXN0YWdlbnQtdGVsZW1ldHJ5"))
export const enabled = true
const processID = crypto.randomUUID()

const headers = Flag.OTEL_EXPORTER_OTLP_HEADERS
  ? Flag.OTEL_EXPORTER_OTLP_HEADERS.split(",").reduce(
      (acc, x) => {
        const [key, ...value] = x.split("=")
        acc[key] = value.join("=")
        return acc
      },
      {} as Record<string, string>,
    )
  : undefined

export function resource(): { serviceName: string; serviceVersion: string; testagentVersion: string; attributes: Record<string, string> } {
  const processMetadata = ensureProcessMetadata("main")
  const attributes: Record<string, string> = (() => {
    const value = process.env.OTEL_RESOURCE_ATTRIBUTES
    if (!value) return {}
    try {
      return Object.fromEntries(
        value.split(",").map((entry) => {
          const index = entry.indexOf("=")
          if (index < 1) throw new Error("Invalid OTEL_RESOURCE_ATTRIBUTES entry")
          return [decodeURIComponent(entry.slice(0, index)), decodeURIComponent(entry.slice(index + 1))]
        }),
      )
    } catch {
      return {}
    }
  })()
  const pathPart = userPathName ? userPathName.split("/") : []

  return {
    serviceName: "testagent",
    serviceVersion: InstallationVersion,
    testagentVersion: InstallationVersion,
    attributes: {
      ...attributes,
      "deployment.environment.name": InstallationChannel,
      "user.id": userID,
      "user.name": userName,
      "testagent.client": process.env["KILO_CLIENT"] === "tscode" || process.env["KILOCODE_FEATURE"] === "tscode-extension" || process.env["KILO_PLATFORM"] === "tscode" ? "tscode" : "cli",
      "testagent.process_role": processMetadata.processRole,
      "testagent.run_id": processMetadata.runID,
      "service.instance.id": processID,
      ...(pathPart.length > 0 ? {
        "user.path_name": userPathName,
        "user.org.enterprise": pathPart[0] || "",
        "user.org.institution": pathPart[1] || "",
        "user.org.department": pathPart[2] || "",
        "user.org.center": pathPart[3] || "",
        "user.org.team": pathPart[4] || "",
        "user.org.room": pathPart[5] || "",
        "user.org.group": pathPart[6] || "",
      } : {}),
    },
  }
}

function logs() {
  return Logger.layer(
    [
      EffectLogger.logger,
      OtlpLogger.make({
        url: `${base}/v1/logs`,
        resource: resource(),
        headers,
      }),
    ],
    { mergeWithExisting: false },
  ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
}

// Global metrics singleton — created once, runs forever.
// This avoids duplicate PeriodicExportingMetricReaders when the same
// NodeSdk.layer is built in multiple ManagedRuntime scopes, since
// @effect/opentelemetry's Metrics.layer() calls reader.setMetricProducer()
// which can only be called once per MetricReader instance.
let metricsInit: Promise<void> | undefined

async function initMetrics() {
  if (metricsInit) return metricsInit
  metricsInit = (async () => {
    const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics")
    const { OTLPMetricExporter, AggregationTemporalityPreference } = await import("@opentelemetry/exporter-metrics-otlp-http")
    const { makeProducer } = await import("@effect/opentelemetry/Metrics")
    const { layer: resourceLayer } = await import("@effect/opentelemetry/Resource")

    const res = resource()
    const producer = Effect.runSync(
      Effect.provide(
        makeProducer("delta"),
        resourceLayer({ serviceName: res.serviceName, serviceVersion: res.serviceVersion, attributes: res.attributes }),
      ),
    )
    const reader = new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${base}/v1/metrics`,
        headers,
        temporalityPreference: AggregationTemporalityPreference.DELTA,
      }),
      exportIntervalMillis: 10000,
    })
    reader.setMetricProducer(producer)
  })()
  return metricsInit
}

const traces = async () => {
  const NodeSdk = await import("@effect/opentelemetry/NodeSdk")
  const OTLP = await import("@opentelemetry/exporter-trace-otlp-http")
  const SdkBase = await import("@opentelemetry/sdk-trace-base")

  // @effect/opentelemetry creates a NodeTracerProvider but never calls
  // register(), so the global @opentelemetry/api context manager stays
  // as the no-op default. Non-Effect code (like the AI SDK) that calls
  // tracer.startActiveSpan() relies on context.active() to find the
  // parent span - without a real context manager every span starts a
  // new trace. Registering AsyncLocalStorageContextManager fixes this.
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks")
  const { context } = await import("@opentelemetry/api")
  const mgr = new AsyncLocalStorageContextManager()
  mgr.enable()
  context.setGlobalContextManager(mgr)

  await initMetrics()

  return NodeSdk.layer(() => ({
    resource: resource(),
    spanProcessor: new SdkBase.BatchSpanProcessor(
      new OTLP.OTLPTraceExporter({
        url: `${base}/v1/traces`,
        headers,
      }),
    ),
  }))
}

let sdkPromise: Promise<any> | undefined

export const layer = !base
  ? EffectLogger.layer
  : Layer.unwrap(
      Effect.gen(function* () {
        if (!sdkPromise) sdkPromise = traces()
        const sdk = yield* Effect.promise(() => sdkPromise!)
        return Layer.mergeAll(sdk, logs())
      }),
    )

// testagent_change start
let userID = ""
let userName = ""
let userPathName = ""

export function setUser(id: string, name: string, pathName?: string) {
  userID = id
  userName = name
  userPathName = pathName ?? ""
}
export const failExecution = Metric.counter("tool.fail.execution", {
  description: "Tool call failures due to execution error",
})
export const failInvalidArgs = Metric.counter("tool.fail.invalid_args", {
  description: "Tool calls with invalid arguments",
})
export const callTotal = Metric.counter("tool.call.total", {
  description: "Total tool calls made by LLM",
})
export const sessionCreated = Metric.counter("session.created", {
  description: "Total of new sessions created",
})
export const llmRequest = Metric.counter("session.llm.request", {
  description: "Total of LLM requests made",
})
export const sessionCompacted = Metric.counter("session.compacted", {
  description: "Total of sessions compacted",
})
export const questionAsk = Metric.counter("tool.question.ask", {
  description: "Total question tool calls",
})
export const taskCall = Metric.counter("tool.task.call", {
  description: "Total task tool calls",
})
export const ttft = Metric.gauge("session.llm.ttft", {
  description: "Time to first token (ms)",
})
export const tokenInput = Metric.counter("session.token.input", {
  description: "Input tokens consumed",
})
export const tokenOutput = Metric.counter("session.token.output", {
  description: "Output tokens generated",
})
export const tokenReasoning = Metric.counter("session.token.reasoning", {
  description: "Reasoning tokens generated",
})
export const tokenCacheRead = Metric.counter("session.token.cache_read", {
  description: "Cache read tokens",
})
export const tokenCacheWrite = Metric.counter("session.token.cache_write", {
  description: "Cache write tokens",
})
export const tokenTotal = Metric.counter("session.token.total", {
  description: "Total tokens consumed (input + output + reasoning + cache)",
})
// testagent_change end

export const Observability = { enabled, layer }
