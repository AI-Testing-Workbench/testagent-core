import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import type { Step } from "./replay-script"

const usage: LanguageModelV3Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
}

function packed(input: unknown) {
  if (typeof input === "string") return input
  return JSON.stringify(input ?? {})
}

function chunks(text: string, size = 24) {
  if (!text) return []
  return Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, i * size + size))
}

function finish(step: Step): LanguageModelV3FinishReason {
  const unified = step.tools.length > 0 ? "tool-calls" : step.reason === "length" ? "length" : "stop"
  return { unified, raw: step.reason ?? unified }
}

function parts(step: Step): LanguageModelV3StreamPart[] {
  const out: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }]
  if (step.reasoning) {
    out.push({ type: "reasoning-start", id: "reasoning-0" })
    for (const delta of chunks(step.reasoning)) {
      out.push({ type: "reasoning-delta", id: "reasoning-0", delta })
    }
    out.push({ type: "reasoning-end", id: "reasoning-0" })
  }
  if (step.text) {
    out.push({ type: "text-start", id: "txt-0" })
    for (const delta of chunks(step.text)) {
      out.push({ type: "text-delta", id: "txt-0", delta })
    }
    out.push({ type: "text-end", id: "txt-0" })
  }
  for (const tool of step.tools) {
    const input = packed(tool.input)
    out.push({ type: "tool-input-start", id: tool.callID, toolName: tool.tool })
    if (input) out.push({ type: "tool-input-delta", id: tool.callID, delta: input })
    out.push({ type: "tool-input-end", id: tool.callID })
    out.push({
      type: "tool-call",
      toolCallId: tool.callID,
      toolName: tool.tool,
      input,
    })
  }
  out.push({ type: "finish", usage, finishReason: finish(step) })
  return out
}

function content(step: Step): LanguageModelV3Content[] {
  const out: LanguageModelV3Content[] = []
  if (step.reasoning) out.push({ type: "reasoning", text: step.reasoning })
  if (step.text) out.push({ type: "text", text: step.text })
  for (const tool of step.tools) {
    out.push({
      type: "tool-call",
      toolCallId: tool.callID,
      toolName: tool.tool,
      input: packed(tool.input),
    })
  }
  return out
}

export function create(step: Step): LanguageModelV3 {
  return {
    specificationVersion: "v3" as const,
    provider: "replay",
    modelId: "replay",
    supportedUrls: {},
    doGenerate: async (_opts: LanguageModelV3CallOptions) => ({
      content: content(step),
      finishReason: finish(step),
      usage,
      warnings: [],
    }),
    doStream: async (_opts: LanguageModelV3CallOptions) => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(ctrl) {
          for (const part of parts(step)) ctrl.enqueue(part)
          ctrl.close()
        },
      }),
    }),
  }
}

export * as ReplayModel from "./replay-model"
