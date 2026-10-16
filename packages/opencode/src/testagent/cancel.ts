// testagent_change - new file
/**
 * 会话取消编排（支持停止 subagent）
 *
 * 背景：subagent 运行在子会话的 SessionRunState Runner 上。取消子会话会让
 * 父任务工具中 `ensureRunning` 的等待方拿到 onInterrupt（最后一条 assistant
 * 消息）并正常返回，因此父工具调用不会被视为失败，无需改动 task 工具本身。
 *
 * scope 语义：
 * - "session"（默认，保持既有行为）：只取消传入的这一个会话，不影响其子会话。
 * - "tree"：取消传入会话及其全部后代会话（用于"停止这个 subagent 连同它启动的一切"）。
 *
 * 设计为纯编排函数，不依赖 InstanceState / Bus，便于单测与复用。
 */
import type { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import type { IdleReason } from "@/session/status"
import { Effect } from "effect"

/** 递归收集一个会话的全部后代会话 ID（广度优先，深度优先均可，顺序无关）。 */
export function descendants(
  sessions: Pick<Session.Interface, "children">,
  sessionID: SessionID,
): Effect.Effect<SessionID[]> {
  return Effect.gen(function* () {
    const children = yield* sessions.children(sessionID)
    const nested = yield* Effect.forEach(children, (child) => descendants(sessions, child.id), {
      concurrency: "unbounded",
    })
    return [...children.map((child) => child.id), ...nested.flat()]
  })
}

/**
 * 被用户手动停止的会话登记表（进程内，带 TTL）。
 *
 * 为什么需要它：`SessionStatus.set` 写入 idle 时会 `data.delete(sessionID)`，
 * 因此事后 `SessionStatus.get` 只能拿到无 reason 的 `{ type: "idle" }`，
 * 无法据此判断"这次 idle 到底是不是用户手动停止造成的"。
 * 又因为 Runner 被中断时，等待中的 prompt 会拿到 onInterrupt（子会话最后一条
 * assistant 消息），若该消息只有 tool part 而没有 text part，task 工具就会提取到
 * 空输出，父 LLM 会把"被用户停止"误当成正常完成。
 *
 * 所以取消方显式登记，由 task 工具在子会话结束后消费一次，用于构造明确的取消结果。
 */
const stopped = new Map<string, number>()
const STOP_TTL_MS = 60_000

/** 登记某个会话是被用户手动停止的。 */
export function markStopped(sessionID: SessionID): void {
  const now = Date.now()
  for (const [id, at] of stopped) if (now - at > STOP_TTL_MS) stopped.delete(id)
  stopped.set(sessionID, now)
}

/** 消费登记（只生效一次），返回该会话是否被用户手动停止。 */
export function consumeStopped(sessionID: SessionID): boolean {
  return stopped.delete(sessionID)
}

/**
 * 按 scope 取消会话。
 * 不用 Effect.fn（保持函数签名可用于测试中的直接调用与 mock）。
 */
export function cancelTree(input: {
  sessionID: SessionID
  scope?: "session" | "tree"
  reason?: IdleReason
  sessions: Pick<Session.Interface, "children">
  cancel: (sessionID: SessionID, reason?: IdleReason) => Effect.Effect<void>
  /**
   * 在每个目标会话被取消**之前**，清理其挂起的人机交互请求（question / permission）。
   *
   * 顺序不可颠倒：Runner 中断时，等待中的 ask fiber 被取消，其 `Effect.ensuring`
   * finalizer 会静默删除 pending 记录且不广播事件，前端拿不到 question.rejected /
   * permission.replied，弹窗就会一直挂在界面上。先 reject 才能走正常拒绝路径并广播事件。
   */
  clearRequests?: (sessionID: SessionID) => Effect.Effect<void>
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const targets =
      input.scope === "tree"
        ? [input.sessionID, ...(yield* descendants(input.sessions, input.sessionID))]
        : [input.sessionID]
    yield* Effect.forEach(
      targets,
      (id) =>
        Effect.gen(function* () {
          markStopped(id)
          if (input.clearRequests) yield* input.clearRequests(id)
          yield* input.cancel(id, input.reason)
        }),
      {
        concurrency: "unbounded",
        discard: true,
      },
    )
  })
}
