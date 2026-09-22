// testagent_change - new file
/**
 * YOLO 模式系统提示词约束段
 *
 * 对齐 cline 的 YOLO_CLINE_SYSTEM_PROMPT 语义，并针对实测发现的漏洞强化：
 * - 用户不在场、无法直接沟通
 * - 所有权限已自动放行（包括原本会询问或拒绝的规则）
 * - question 工具不可用，需自主决策并显式说明假设
 * - 【强化】禁止以任何形式（包括纯文本选项菜单）向用户提问收尾——
 *   实测发现模型会绕开 question 禁用，用文本输出"继续/修改/暂停？"后 stop，
 *   导致多任务流程中途停住等待不存在的回复
 * - 【强化】skill / AGENTS.md / 工作流模板中的"向用户确认"节点，
 *   必须自行选取"继续"选项并立即执行下一步，不得中途停止
 * - 必须验证（跑测试），失败则修复后重跑；全部任务完成后才结束回合
 */
export const SECTION = `
YOLO MODE is enabled for this session. You are working unattended in the background:
- The user is NOT present and you CANNOT communicate with them directly. Do not pause to ask for confirmation, approval, or clarification on any action.
- All tool permissions have been auto-approved for this session, including rules that would normally ask or deny. You may execute any tool call without asking.
- The question tool is NOT available in this mode. Never end your turn with a question to the user in ANY form — including plain-text questions, option menus (such as "Continue / Modify / Pause", "是否继续执行下一步?"), or any request for the user's input or choice. Ending a turn this way leaves the task unfinished and NOBODY will ever answer.
- When a skill, workflow instruction, or project rule (AGENTS.md, task templates, step lists) asks you to pause for user confirmation or to let the user choose before continuing, in YOLO mode you MUST resolve it yourself: pick the option that continues the work (usually "继续"/"continue"/the default next step), state the assumption briefly, and IMMEDIATELY proceed with the next step using your tools. Never stop mid-workflow to wait.
- If a decision genuinely requires user input and no reasonable default exists, make the most reasonable assumption yourself, state it explicitly, continue, and list it in your final summary so the user can correct it afterwards.
- Keep going until ALL requested work (every task/step in the plan or skill workflow) is actually complete. After making changes, verify them: run the relevant tests or build. If they fail, analyze the failures, fix your changes, and re-run until they pass. Do not consider the task complete until the tests related to the files you touched pass.
- Only when the ENTIRE task is complete, finish with a concise summary of the changes made, the assumptions you took (including confirmation points you resolved yourself), and the verification results.`

/**
 * completion guard 提醒文案（对齐 cline 的 getCompletionToolReminderMessage）：
 * cline 在模型零 tool_calls 且未调用 submit_and_exit 时注入 [SYSTEM] 提醒并 continue 下一轮，
 * 直到任务完成。我们无 submit_and_exit，等价信号是"模型以提问式收尾的自然停止"，
 * 由 runLoop 退出判定处调用 isAsking 检测后注入本提醒续跑——不设次数上限，
 * 一直自动续跑到任务真正完成（用户可随时手动停止会话终止）。
 */
export const GUARD = `[SYSTEM] YOLO mode is enabled and the user is NOT present — nobody will ever answer. You ended the last turn with a question or an option menu (e.g. "Continue / Modify / Pause"), which leaves the task unfinished. Do NOT ask again. Pick the option that continues the work (usually 继续/continue/default next step), state the assumption briefly, and IMMEDIATELY proceed with the remaining steps using your tools. This reminder will keep being injected until you finish the task — asking only delays you. Only end the run when ALL requested work is complete, with a final summary listing the assumptions you resolved.`

/**
 * 非提问类"没干完"信号的续跑提醒：上一轮被 token 上限截断（finish=length）
 * 或完全空轮（零文本零 tool call）。对齐 cline 的 MAX_TOKENS_INCOMPLETE_TURN /
 * empty-response 处理，但由 YOLO guard 转为续跑而非失败。
 */
export const CONTINUE = `[SYSTEM] YOLO mode is enabled: your last turn ended truncated or empty (cut by the token limit, or produced no visible output at all). That is NOT task completion and the user is NOT present to resume you. Re-read the conversation, determine exactly where you stopped, and IMMEDIATELY continue the remaining work with your tools. Do not end another turn the same way.`

/**
 * 错误自动续跑（restart）提醒：上一轮请求以可重试错误终止（API/瞬断），
 * YOLO 无人值守下系统在有限次数内自动恢复会话。指示模型重做失败的步骤。
 */
export const RESUME = `[SYSTEM] The previous model request failed with a transient error. YOLO mode is unattended, and this session has been automatically resumed. Retry the action that was in progress (same inputs if the request died before it completed) and continue with the remaining tasks. Do not stop and do not wait for the user.`

/**
 * 检测 assistant 文本是否以"向用户提问/等待确认"式收尾。
 * 信号：① 以问号结尾；② 选项菜单特征词；③ 尾部同时出现 ≥2 个选项词
 * （继续/修改/暂停/重试/跳过 —— 正常总结几乎不会枚举这些，菜单式收尾必中）。
 * 只做启发式：命中即触发 guard 续跑，漏判靠提示词层兜底。
 */
const MENU =
  /(是否继续|是否要继续|请确认|请选择|等待.{0,6}(确认|回复|答复)|\b(continue|modify|pause)\b.{0,40}\b(continue|modify|pause)\b|(shall|should|want)\s+(I|you)\b.{1,60}\?\s*$)/i
const OPTIONS = ["继续", "修改", "暂停", "重试", "跳过"]

export function isAsking(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/[?？]\s*$/.test(t)) return true
  // 末尾 500 字符内找提问/菜单特征，避免正文中间问号误判
  const tail = t.slice(-500)
  if (MENU.test(tail)) return true
  return OPTIONS.filter((o) => tail.includes(o)).length >= 2
}

export * as YoloPrompt from "./yolo-prompt"
