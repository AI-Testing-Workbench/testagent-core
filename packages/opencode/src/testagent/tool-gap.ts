/**
 * 「最后工具执行完成 → 下一轮 LLM 请求发出」间隙耗时。
 *
 * 以最后一个完成的工具为起点，累计到下一次 LLM 请求发出为止，包含：
 *   1) finish-step 收尾（token/usage 统计、snapshot.patch、summary fork）
 *   2) process cleanup
 *   3) 外层 agent loop 重入（消息重载、latest、model/agent 解析、insertReminders）
 *   4) processor.create 的 snapshot.track
 *   5) resolveTools
 *   6) system prompt / toModelMessages 组装
 *   7) process 入口（config.get、token 估算）
 *
 * 并发执行多个工具时，以最后完成的那个工具作为起点（这里用 Math.max 取最大完成时间）。
 *
 * 注意：question 工具、权限确认等「等待用户」发生在工具 execute 期间，
 * done() 只有在工具真正完成后才记录，因此等待时间不计入本间隙（会算在工具耗时里）。
 *
 * 上报方式：OTLP counter `session.tool_to_llm.total`（见 observability.ts），
 * 每个 step 增量累加一次；按 sessionID 求和即会话汇总耗时。
 *
 * 开关：默认开启；设置 TESTAGENT_LATENCY=0 可关闭。
 */

const ENABLED = process.env.TESTAGENT_LATENCY !== "0"

const marks = new Map<string, number>()

export function enabled(): boolean {
  return ENABLED
}

/** 记录一次工具完成；并发时保留最晚的完成时间。 */
export function done(sessionID: string): void {
  if (!ENABLED) return
  marks.set(sessionID, Math.max(marks.get(sessionID) ?? 0, performance.now()))
}

/** 取出并清空间隙；没有待消费的记录时返回 undefined。 */
export function take(sessionID: string): number | undefined {
  if (!ENABLED) return
  const at = marks.get(sessionID)
  if (at === undefined) return
  marks.delete(sessionID)
  return performance.now() - at
}

/** 丢弃未消费的记录，避免把用户空闲时间算进下一次请求。 */
export function reset(sessionID: string): void {
  marks.delete(sessionID)
}
