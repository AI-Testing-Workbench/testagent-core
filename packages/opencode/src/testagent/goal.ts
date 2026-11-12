// testagent_change - new file
/**
 * Goal 模式（全局开关，进程级状态）
 *
 * 语义（对齐 YOLO 模式）：
 * - 全局开关：开启后本服务器具备 goal 能力（goal 工具 + /goal 命令 + 目标提醒注入）
 * - 生命周期：进程级内存态，服务器重启后重置
 * - 初始值：环境变量 TESTAGENT_GOAL=1 时进程启动即开启
 *
 * 与 YOLO 的分工：
 * - 开关本身是**能力开关**（这个服务器有没有 goal 能力），进程级、跨会话
 * - goal 的**状态**（目标本身）是 per-session，存在 goals.json，与本模块正交
 *
 * auto_continue 抑制：
 * - goal 插件的自动续跑挂在 session.idle 上，会往同一会话注入 promptAsync
 * - SDT 阶段链自己驱动回合（阶段链 + gate + retry），两者同时开会交错 prompt、
 *   污染阶段 transcript、双算 token
 * - 因此需要按 session 抑制自动续跑，抑制集合在本模块维护（运行时可变，
 *   不依赖 Effect 上下文，任何调用点都能同步读）
 *
 * 设计为无 Effect 依赖的纯模块，理由同 testagent/yolo.ts：
 * - 开关请求走 /testagent/* root 路由（无 per-instance 目录上下文），
 *   而插件的检查点在 session 上下文中
 * - 开关事件通过 GlobalBus 进程级广播（与 zh.answer.toggled 同模式）
 */
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { GlobalBus, type GlobalEvent } from "@/bus/global"

const log = Log.create({ service: "testagent.goal" })

let enabled = process.env.TESTAGENT_GOAL === "1"

/** 抑制自动续跑的 session 集合（per-session，运行时可变） */
const autoContinueSuppressed = new Set<string>()

export const Event = {
  Enabled: "testagent.goal.enabled" as const,
  Disabled: "testagent.goal.disabled" as const,
}

/** 设置 Goal 全局开关（幂等） */
export function set(next: boolean): void {
  if (enabled === next) return
  enabled = next
  log.info(next ? "goal enabled (global)" : "goal disabled (global)")
  GlobalBus.emit("event", {
    payload: {
      type: next ? Event.Enabled : Event.Disabled,
      properties: {},
    },
  })
}

/** 当前 Goal 开关状态（同步读，无 Effect 上下文依赖） */
export function isEnabled(): boolean {
  return enabled
}

/**
 * 等待下一次"开启"的唤醒 Effect：触发一次即 resolve，随后自动注销监听。
 * 模式对齐 testagent/yolo.ts 的 onEnabled（Effect.callback + 返回清理 Effect）。
 */
export function onEnabled(): Effect.Effect<void> {
  if (isEnabled()) return Effect.void
  return Effect.callback<void>((resume) => {
    const handler = (event: GlobalEvent) => {
      if (event.payload?.type !== Event.Enabled) return
      resume(Effect.void)
    }
    GlobalBus.on("event", handler)
    return Effect.sync(() => GlobalBus.off("event", handler))
  })
}

/** 抑制指定会话的自动续跑（SDT 阶段链驱动回合时调用） */
export function suppressAutoContinue(sessionID: string): void {
  if (!sessionID) return
  autoContinueSuppressed.add(sessionID)
}

/** 解除指定会话的自动续跑抑制 */
export function releaseAutoContinue(sessionID: string): void {
  if (!sessionID) return
  autoContinueSuppressed.delete(sessionID)
}

/** 该会话的自动续跑是否被抑制 */
export function isAutoContinueSuppressed(sessionID: string): boolean {
  if (!sessionID) return false
  return autoContinueSuppressed.has(sessionID)
}

/** 重置为关闭（进程退出钩子等场景使用，可选） */
export function reset(): void {
  enabled = false
  autoContinueSuppressed.clear()
}

export * as Goal from "./goal"
