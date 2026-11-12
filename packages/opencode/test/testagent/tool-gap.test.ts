import { describe, expect, test } from "bun:test"
import * as ToolGap from "../../src/testagent/tool-gap"

const id = () => crypto.randomUUID()

describe("tool-gap", () => {
  test("returns undefined when no tool has completed", () => {
    if (!ToolGap.enabled()) return
    expect(ToolGap.take(id())).toBeUndefined()
  })

  test("take returns elapsed time and clears the mark", async () => {
    if (!ToolGap.enabled()) return
    const session = id()
    ToolGap.done(session)
    await Bun.sleep(5)
    const gap = ToolGap.take(session)
    expect(gap).toBeGreaterThanOrEqual(5)
    expect(ToolGap.take(session)).toBeUndefined()
  })

  test("parallel tools use the last completion", async () => {
    if (!ToolGap.enabled()) return
    const session = id()
    ToolGap.done(session)
    await Bun.sleep(30)
    ToolGap.done(session)
    const gap = ToolGap.take(session)
    expect(gap).toBeLessThan(25)
  })

  test("reset discards a pending mark", () => {
    if (!ToolGap.enabled()) return
    const session = id()
    ToolGap.done(session)
    ToolGap.reset(session)
    expect(ToolGap.take(session)).toBeUndefined()
  })

  test("sessions are isolated", async () => {
    if (!ToolGap.enabled()) return
    const a = id()
    const b = id()
    ToolGap.done(a)
    await Bun.sleep(5)
    expect(ToolGap.take(b)).toBeUndefined()
    expect(ToolGap.take(a)).toBeGreaterThanOrEqual(5)
  })
})
