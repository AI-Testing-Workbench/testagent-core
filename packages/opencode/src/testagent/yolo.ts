// testagent_change - new file
/**
 * YOLO 模式（全局开关，进程级状态）
 *
 * 语义（对齐用户要求）：
 * - 全局开关：开启后【所有会话】均采用 YOLO 模式，与具体 session 无关
 * - 生命周期：进程级内存态，VS Code / CLI 重启后重置
 * - 初始值：环境变量 TESTAGENT_YOLO=1 时进程启动即开启（供 CI/脚本无人值守）
 * - 唯一关闭途径：手动关闭
 * - 开启瞬间：已通过 onEnabled 唤醒存量挂起的权限/问题请求并自动放行
 *
 * 行为（对齐 cline yolo mode）：
 * 1. 绕过所有权限规则（包括 deny），所有工具直接放行，不挂起等待审批
 * 2. question 工具对模型不可用（工具列表过滤 + AI SDK NoSuchToolError 回退），
 *    模型无法提问用户，需自主决策
 * 3. 系统提示词追加 YOLO 约束段，明确"用户不在场"
 *
 * 设计为无 Effect 依赖的纯模块：
 * - 前端开关请求走 /testagent/* root 路由（无 per-instance 目录上下文），
 *   而 permission/llm/prompt/question 的检查点在 session 上下文中，
 *   纯模块函数在任何上下文都能同步调用，不产生 layer 组合问题。
 * - 开关事件通过 GlobalBus 进程级广播（与 zh.answer.toggled 同模式）。
 */
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { GlobalBus, type GlobalEvent } from "@/bus/global"

const log = Log.create({ service: "testagent.yolo" })

let enabled = process.env.TESTAGENT_YOLO === "1"

export const Event = {
  Enabled: "testagent.yolo.enabled" as const,
  Disabled: "testagent.yolo.disabled" as const,
}

/** 设置 YOLO 全局开关（幂等） */
export function set(next: boolean): void {
  if (enabled === next) return
  enabled = next
  log.info(next ? "yolo enabled (global)" : "yolo disabled (global)")
  GlobalBus.emit("event", {
    payload: {
      type: next ? Event.Enabled : Event.Disabled,
      properties: {},
    },
  })
}

/** 当前 YOLO 开关状态（同步读，无 Effect 上下文依赖） */
export function isEnabled(): boolean {
  return enabled
}

/**
 * 等待下一次"开启"的唤醒 Effect：触发一次即 resolve，随后自动注销监听。
 * 供存量挂起的 permission ask / question 使用：开启瞬间自动放行，
 * 避免无人值守时旧请求永久等待用户回复。
 * 若调用时已处于开启态则立即 resolve（封住 check→挂起之间的竞态窗口）。
 * 模式对齐 control-plane/util.ts 的 waitEvent（Effect.callback + 返回清理 Effect）。
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

/** 重置为关闭（进程退出钩子等场景使用，可选） */
export function reset(): void {
  enabled = false
}

export * as Yolo from "./yolo"
