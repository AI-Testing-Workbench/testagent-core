import { afterEach, describe, expect, test } from "bun:test"
import { ReplayScript } from "../../src/testagent/replay-script"

afterEach(() => {
  ReplayScript.reset()
})

describe("replay script", () => {
  test("arm then pull consumes once", () => {
    ReplayScript.arm("ses_1", { text: "hi", tools: [] })
    expect(ReplayScript.live("ses_1")).toBe(true)
    expect(ReplayScript.spent("ses_1")).toBe(false)

    const step = ReplayScript.pull("ses_1", { agent: "build" })
    expect(step?.text).toBe("hi")
    expect(ReplayScript.spent("ses_1")).toBe(true)

    const again = ReplayScript.pull("ses_1", { agent: "build" })
    expect(again).toEqual({ tools: [], reason: "stop" })
  })

  test("title and small calls do not consume", () => {
    ReplayScript.arm("ses_2", { text: "keep", tools: [{ tool: "bash", callID: "c1", input: { command: "ls" } }] })
    expect(ReplayScript.pull("ses_2", { small: true })).toBeUndefined()
    expect(ReplayScript.pull("ses_2", { agent: "title" })).toBeUndefined()
    expect(ReplayScript.pull("ses_2", { agent: "compaction" })).toBeUndefined()
    expect(ReplayScript.spent("ses_2")).toBe(false)
    expect(ReplayScript.pull("ses_2", { agent: "build" })?.text).toBe("keep")
  })

  test("unarmed session falls through", () => {
    expect(ReplayScript.pull("ses_missing", { agent: "build" })).toBeUndefined()
    expect(ReplayScript.live("ses_missing")).toBe(false)
  })

  test("queue pulls each step then stops", () => {
    ReplayScript.arm("ses_3", [
      { text: "one", tools: [{ tool: "bash", callID: "c1", input: { command: "ls" } }] },
      { text: "two", tools: [] },
    ])
    expect(ReplayScript.spent("ses_3")).toBe(false)
    expect(ReplayScript.pull("ses_3", { agent: "build" })?.text).toBe("one")
    expect(ReplayScript.spent("ses_3")).toBe(false)
    expect(ReplayScript.pull("ses_3", { agent: "build" })?.text).toBe("two")
    expect(ReplayScript.spent("ses_3")).toBe(true)
    expect(ReplayScript.pull("ses_3", { agent: "build" })).toEqual({ tools: [], reason: "stop" })
  })

  test("pending stays true until the queue is empty", () => {
    expect(ReplayScript.pending("ses_4")).toBe(false)
    ReplayScript.arm("ses_4", [
      { text: "one", tools: [] },
      { text: "two", tools: [] },
    ])
    expect(ReplayScript.pending("ses_4")).toBe(true)
    ReplayScript.pull("ses_4", { agent: "build" })
    expect(ReplayScript.pending("ses_4")).toBe(true)
    ReplayScript.pull("ses_4", { agent: "build" })
    expect(ReplayScript.pending("ses_4")).toBe(false)
    expect(ReplayScript.spent("ses_4")).toBe(true)
  })
})
