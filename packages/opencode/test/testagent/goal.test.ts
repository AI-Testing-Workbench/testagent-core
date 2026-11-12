// testagent_change - new file
/**
 * Goal 模式 runtime 开关行为单测
 *
 * 覆盖：
 * 1. 全局状态 set/isEnabled 幂等、reset 复位（纯模块，无需 instance）
 * 2. auto_continue 抑制集合的增删查
 * 3. 插件门控：Goal 能力关闭时，即便会话有 active 目标，goal 工具仍被禁用
 * 4. 插件门控：Goal 能力开启且会话有 active 目标时，goal 工具不被禁用
 * 5. 插件门控：Goal 能力关闭时 /goal 命令不解锁 goal 工具
 * 6. auto_continue 接缝：被抑制的会话在 session.idle 时不触发自动续跑
 */
import {afterEach, beforeEach, describe, expect, test} from "bun:test"
import {mkdtempSync, rmSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {Goal} from "../../src/testagent/goal"
import {GoalPlugin} from "../../src/plugin/testagent-goal/index"
import {clearGoal, createGoal, getGoal} from "../../src/plugin/testagent-goal/state"

const sessionID = "ses_goal_global_test"

let stateDir: string

beforeEach(() => {
  // goal 状态写文件，测试期间指向临时目录，避免污染真实 goals.json
  stateDir = mkdtempSync(join(tmpdir(), "testagent-goal-"))
  process.env.TESTAGENT_GOAL_STATE_PATH = join(stateDir, "goals.json")
})

afterEach(() => {
  Goal.reset()
  Goal.set(false)
  delete process.env.TESTAGENT_GOAL_STATE_PATH
  rmSync(stateDir, {recursive: true, force: true})
})

describe("goal global state", () => {
  test("set/isEnabled 幂等且全局生效", () => {
    Goal.set(false)
    expect(Goal.isEnabled()).toBe(false)

    Goal.set(true)
    expect(Goal.isEnabled()).toBe(true)
    // 幂等
    Goal.set(true)
    expect(Goal.isEnabled()).toBe(true)

    Goal.set(false)
    expect(Goal.isEnabled()).toBe(false)

    Goal.set(true)
    Goal.reset()
    expect(Goal.isEnabled()).toBe(false)
  })
})

describe("goal auto_continue 抑制接缝", () => {
  test("抑制 / 解除 / 查询", () => {
    expect(Goal.isAutoContinueSuppressed(sessionID)).toBe(false)
    Goal.suppressAutoContinue(sessionID)
    expect(Goal.isAutoContinueSuppressed(sessionID)).toBe(true)
    Goal.releaseAutoContinue(sessionID)
    expect(Goal.isAutoContinueSuppressed(sessionID)).toBe(false)
  })

  test("空 sessionID 不进入抑制集合", () => {
    Goal.suppressAutoContinue("")
    expect(Goal.isAutoContinueSuppressed("")).toBe(false)
  })

  test("reset 清空抑制集合", () => {
    Goal.suppressAutoContinue(sessionID)
    Goal.reset()
    expect(Goal.isAutoContinueSuppressed(sessionID)).toBe(false)
  })
})

/** 构造一条最小可用的 user message */
function userMessage(tools?: Record<string, boolean>) {
  return {
    info: {role: "user" as const, sessionID, tools: tools ?? {}},
    parts: [],
  }
}

/** 拿到插件的 hooks（跳过 config hook，只测运行时门控） */
async function pluginHooks(options?: Record<string, unknown>) {
  const promptAsync = async () => {}
  const plugin = await GoalPlugin({client: {session: {promptAsync}}} as never, options)
  return {plugin, promptAsync}
}

describe("goal plugin 运行时门控", () => {
  test("Goal 关闭：会话有 active 目标时 goal 工具仍被禁用", async () => {
    await createGoal(sessionID, "把需求洗干净")
    expect((await getGoal(sessionID))?.status).toBe("active")

    Goal.set(false)
    const {plugin} = await pluginHooks()
    const output = {messages: [userMessage()], system: [] as string[]}
    await (plugin["experimental.chat.messages.transform"] as never as Function)({}, output)

    expect(output.messages[0]!.info.tools!.create_goal).toBe(false)
    expect(output.messages[0]!.info.tools!.update_goal).toBe(false)
  })

  test("Goal 开启且会话有 active 目标：goal 工具不被禁用", async () => {
    await createGoal(sessionID, "把需求洗干净")

    Goal.set(true)
    const {plugin} = await pluginHooks()
    const output = {messages: [userMessage()], system: [] as string[]}
    await (plugin["experimental.chat.messages.transform"] as never as Function)({}, output)

    // 工具未被禁用——键不存在即为未置 false
    expect(output.messages[0]!.info.tools!.create_goal).toBeUndefined()
    expect(output.messages[0]!.info.tools!.update_goal).toBeUndefined()
  })

  test("Goal 关闭：/goal 命令不解锁 goal 工具", async () => {
    await createGoal(sessionID, "把需求洗干净")

    Goal.set(false)
    const {plugin} = await pluginHooks()
    await (plugin["command.execute.before"] as never as Function)({command: "goal", sessionID}, {})

    const output = {messages: [userMessage()], system: [] as string[]}
    await (plugin["experimental.chat.messages.transform"] as never as Function)({}, output)

    expect(output.messages[0]!.info.tools!.create_goal).toBe(false)
  })

  test("Goal 关闭：工具 execute 抛「能力未开启」而不是建目标", async () => {
    Goal.set(false)
    const {plugin} = await pluginHooks()
    const create = (plugin.tool as never as Record<string, {execute: Function}>).create_goal!

    await expect(create.execute({objective: "偷偷建目标"}, {sessionID})).rejects.toThrow(
      /Goal mode is disabled/,
    )
    expect(await getGoal(sessionID)).toBeNull()
  })
})

describe("goal plugin auto_continue 接缝", () => {
  test("被抑制的会话在 session.idle 时不触发自动续跑", async () => {
    await createGoal(sessionID, "把需求洗干净")
    Goal.set(true)
    Goal.suppressAutoContinue(sessionID)

    let called = 0
    const promptAsync = async () => {
      called++
    }
    const plugin = await GoalPlugin({client: {session: {promptAsync}}} as never, {})

    await (plugin.event as never as Function)({
      event: {type: "session.idle", properties: {sessionID}},
    })

    expect(called).toBe(0)
  })

  test("未被抑制且能力开启时，session.idle 触发自动续跑", async () => {
    await createGoal(sessionID, "把需求洗干净")
    Goal.set(true)

    let called = 0
    const promptAsync = async () => {
      called++
    }
    const plugin = await GoalPlugin({client: {session: {promptAsync}}} as never, {})

    await (plugin.event as never as Function)({
      event: {type: "session.idle", properties: {sessionID}},
    })

    expect(called).toBe(1)
  })

  test("能力关闭时，session.idle 不触发自动续跑", async () => {
    await createGoal(sessionID, "把需求洗干净")
    Goal.set(false)

    let called = 0
    const promptAsync = async () => {
      called++
    }
    const plugin = await GoalPlugin({client: {session: {promptAsync}}} as never, {})

    await (plugin.event as never as Function)({
      event: {type: "session.idle", properties: {sessionID}},
    })

    expect(called).toBe(0)
  })
})

describe("goal 状态：已关闭目标可重建", () => {
  test("clearGoal 后可再建目标", async () => {
    await createGoal(sessionID, "第一个目标")
    await clearGoal(sessionID)
    expect(await getGoal(sessionID)).toBeNull()

    await createGoal(sessionID, "第二个目标")
    expect((await getGoal(sessionID))?.objective).toBe("第二个目标")
  })
})
