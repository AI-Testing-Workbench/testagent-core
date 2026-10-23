// testagent_change - new file
/**
 * 清理会话挂起的人机交互请求（question / permission）
 *
 * 背景：Question.ask / Permission.ask 都用 `Effect.ensuring(...)` 在结束时删除
 * pending 记录，但**不广播任何事件**。Runner 被中断时，等待中的 fiber 被取消，
 * pending 记录被静默删除，前端因为收不到 question.rejected / permission.replied
 * 事件而无法把弹窗移除（表现为：停止 subagent 后 question 弹窗仍挂在界面上）。
 *
 * 因此取消会话前必须显式 reject 这些挂起请求，让 Service 走正常的「拒绝」路径：
 * 删除 pending + 广播事件 + fail 掉 deferred，前端据此关闭弹窗。
 *
 * 设计为接收 Service 实例的函数（与 cancelTree 的 sessions/cancel 同风格），
 * 不直接依赖 Effect 上下文，便于单测。
 */
import type { Permission } from "@/permission"
import type { Question } from "@/question"
import type { SessionID } from "@/session/schema"
import { Effect } from "effect"

/** 拒绝某个会话下所有挂起的 question 请求（广播 question.rejected）。 */
export function clearQuestions(
  question: Pick<Question.Interface, "list" | "reject">,
  sessionID: SessionID,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const pending = (yield* question.list()).filter((item) => item.sessionID === sessionID)
    yield* Effect.forEach(pending, (item) => question.reject(item.id), { concurrency: "unbounded", discard: true })
  })
}

/**
 * 拒绝某个会话下所有挂起的 permission 请求（广播 permission.replied）。
 *
 * 只对第一个请求调用 reply：Permission.reply 在 reply="reject" 时自带同会话级联，
 * 会把该会话剩余 pending 一并拒绝并广播事件；后续请求再调用时已找不到记录，属空操作。
 * 因此取首个即可，且能避免并发下的重复事件。
 */
export function clearPermissions(
  permission: Pick<Permission.Interface, "list" | "reply">,
  sessionID: SessionID,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const first = (yield* permission.list()).find((item) => item.sessionID === sessionID)
    if (!first) return
    yield* permission.reply({ requestID: first.id, reply: "reject" })
  })
}
