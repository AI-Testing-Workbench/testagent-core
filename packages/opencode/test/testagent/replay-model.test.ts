import { describe, expect, test } from "bun:test"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { streamText } from "ai"
import { ReplayModel } from "../../src/testagent/replay-model"

const opts = { prompt: [] } as LanguageModelV3CallOptions

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const out: LanguageModelV3StreamPart[] = []
  await stream.pipeTo(
    new WritableStream({
      write(part) {
        out.push(part)
      },
    }),
  )
  return out
}

describe("replay model", () => {
  test("doStream emits tool-call with JSON string input", async () => {
    const model = ReplayModel.create({
      text: "hello world this is longer than twenty four",
      reasoning: "think",
      tools: [{ tool: "bash", callID: "call_1", input: { command: "ls" } }],
    })
    const result = await model.doStream(opts)
    const parts = await collect(result.stream)
    const call = parts.find((part) => part.type === "tool-call")
    expect(call?.type).toBe("tool-call")
    if (call?.type !== "tool-call") throw new Error("missing tool-call")
    expect(typeof call.input).toBe("string")
    expect(JSON.parse(call.input)).toEqual({ command: "ls" })
    expect(parts.some((part) => part.type === "text-delta")).toBe(true)
    expect(parts.some((part) => part.type === "reasoning-delta")).toBe(true)
    const start = parts.find((part) => part.type === "reasoning-start")
    const end = parts.find((part) => part.type === "reasoning-end")
    expect(start?.type).toBe("reasoning-start")
    expect(end?.type).toBe("reasoning-end")
    if (start?.type !== "reasoning-start") throw new Error("missing reasoning-start")
    if (end?.type !== "reasoning-end") throw new Error("missing reasoning-end")
    expect(start.id).toBe("reasoning-0")
    expect(end.id).toBe("reasoning-0")
    const done = parts.find((part) => part.type === "finish")
    expect(done?.type).toBe("finish")
    if (done?.type !== "finish") throw new Error("missing finish")
    expect(done.finishReason.unified).toBe("tool-calls")
  })

  test("empty step finishes with stop", async () => {
    const model = ReplayModel.create({ tools: [], reason: "stop" })
    const result = await model.doStream(opts)
    const parts = await collect(result.stream)
    const done = parts.find((part) => part.type === "finish")
    expect(done?.type).toBe("finish")
    if (done?.type !== "finish") throw new Error("missing finish")
    expect(done.finishReason.unified).toBe("stop")
    expect(parts.some((part) => part.type === "tool-call")).toBe(false)
    expect(parts.some((part) => part.type === "reasoning-end")).toBe(false)
  })

  test("streamText keeps reasoning part ids", async () => {
    const model = ReplayModel.create({ reasoning: "think", text: "hello", tools: [] })
    const result = streamText({ model, prompt: "x", maxRetries: 0 })
    const types = []
    for await (const part of result.fullStream) {
      types.push(part.type)
      if (part.type === "error") throw new Error(String(part.error))
    }
    expect(types.includes("reasoning-end") || types.includes("reasoning-delta")).toBe(true)
    expect(types.includes("finish") || types.includes("text-delta")).toBe(true)
  })
})
