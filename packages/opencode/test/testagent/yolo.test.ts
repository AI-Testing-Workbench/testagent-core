// testagent_change - new file
/**
 * YOLO 模式行为单测（全局开关）
 *
 * 覆盖：
 * 1. 全局状态 set/isEnabled 幂等、reset 复位（纯模块，无需 instance）
 * 2. Permission：YOLO 关闭时显式 deny 规则照常生效（回归保护）
 * 3. Permission：YOLO 开启时同一 deny 规则被绕过（不抛错、不挂起、无 pending）
 * 4. Permission：YOLO 开启时 ask 规则不挂起直接放行
 * 5. Question：YOLO 开启时新问题自动按第一个选项答复
 * 6. Question：YOLO 开启时无选项问题返回空答案
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Permission, type Ruleset } from "../../src/permission"
import { Question } from "../../src/question"
import { SessionID } from "../../src/session/schema"
import { Yolo } from "../../src/testagent/yolo"
import { YoloPrompt } from "../../src/testagent/yolo-prompt"
import { provideTestInstance } from "../fixture/fixture"

const sessionID = SessionID.make("ses_yolo_global_test")

afterEach(() => {
  Yolo.set(false)
})

describe("yolo global state", () => {
  test("set/isEnabled 幂等且全局生效", () => {
    Yolo.set(false)
    expect(Yolo.isEnabled()).toBe(false)

    Yolo.set(true)
    expect(Yolo.isEnabled()).toBe(true)
    // 幂等
    Yolo.set(true)
    expect(Yolo.isEnabled()).toBe(true)

    Yolo.set(false)
    expect(Yolo.isEnabled()).toBe(false)
    Yolo.set(true)
    Yolo.reset()
    expect(Yolo.isEnabled()).toBe(false)
  })
})

function withInstance<R>(fn: () => R): Promise<R> {
  return provideTestInstance({ directory: process.cwd(), fn })
}

const ask = (permission: string, ruleset: Ruleset) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service
    return yield* svc.ask({
      sessionID,
      permission,
      patterns: ["*"],
      metadata: {},
      always: [],
      ruleset,
    })
  }).pipe(Effect.provide(Permission.defaultLayer))

describe("yolo permission", () => {
  test("YOLO 关闭时显式 deny 规则照常生效（回归保护）", async () => {
    await withInstance(async () => {
      Yolo.set(false)
      const exit = await Effect.runPromise(
        ask("edit", [{ permission: "edit", pattern: "*", action: "deny" }]).pipe(Effect.exit),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })
  })

  test("YOLO 开启时同一 deny 规则被绕过（不抛错、无 pending）", async () => {
    await withInstance(async () => {
      // YOLO 开启：短路发生在规则评估之前，deny 同样放行
      Yolo.set(true)
      await Effect.runPromise(ask("edit", [{ permission: "edit", pattern: "*", action: "deny" }]))

      const pending = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* Permission.Service
          return yield* svc.list()
        }).pipe(Effect.provide(Permission.defaultLayer)),
      )
      expect(pending.filter((p) => p.sessionID === sessionID).length).toBe(0)
    })
  })

  test("YOLO 开启时 ask 规则不挂起直接放行", async () => {
    await withInstance(async () => {
      Yolo.set(true)
      const start = Date.now()
      // 无 YOLO 时 ask 规则会挂起等 reply；短路后同步返回
      await Effect.runPromise(ask("webfetch", [{ permission: "webfetch", pattern: "*", action: "ask" }]))
      expect(Date.now() - start).toBeLessThan(200)
    })
  })
})

describe("yolo question", () => {
  const askQuestion = (options: { label: string; description: string }[]) =>
    Effect.gen(function* () {
      const svc = yield* Question.Service
      return yield* svc.ask({
        sessionID,
        questions: [
          {
            question: "选择方案？",
            header: "方案",
            options,
          },
        ],
      } as any)
    }).pipe(Effect.provide(Question.defaultLayer))

  test("YOLO 开启时新问题自动按第一个选项答复", async () => {
    await withInstance(async () => {
      Yolo.set(true)
      const answers = await Effect.runPromise(
        askQuestion([
          { label: "方案A", description: "a" },
          { label: "方案B", description: "b" },
        ]),
      )
      expect(answers).toEqual([["方案A"]])
    })
  })

  test("YOLO 开启时无选项问题返回空答案", async () => {
    await withInstance(async () => {
      Yolo.set(true)
      const answers = await Effect.runPromise(askQuestion([]))
      expect(answers).toEqual([[]])
    })
  })
})

describe("yolo completion guard (isAsking)", () => {
  test("提问式收尾命中：问号结尾 / 选项菜单 / 确认请求", () => {
    expect(YoloPrompt.isAsking("...是否继续执行 **Task 2**？")).toBe(true)
    expect(YoloPrompt.isAsking("- **继续** - 进入需求分析\n- **修改** - 修改后再继续\n- **暂停** - 稍后继续")).toBe(
      true,
    )
    expect(YoloPrompt.isAsking("Should I continue with Task 2?")).toBe(true)
    expect(YoloPrompt.isAsking("请确认后我再继续")).toBe(true)
  })

  test("正常收尾不误判：总结陈述 / 空文本 / 正文中间问号", () => {
    expect(YoloPrompt.isAsking("Task 2 已完成，所有测试通过，变更已提交。")).toBe(false)
    expect(YoloPrompt.isAsking("")).toBe(false)
    expect(YoloPrompt.isAsking("分析如下：用户为何失败？因为缺少校验。修复方案已实施并通过测试。")).toBe(false)
  })

  test("GUARD 提醒文案存在（自动续跑注入内容）", () => {
    expect(YoloPrompt.GUARD.length).toBeGreaterThan(0)
    expect(YoloPrompt.GUARD).toContain("nobody will ever answer")
  })
})
