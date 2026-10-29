import * as log from "./core/log.js";
import { predictNoul, noulToBool } from "./predict.js";
export function normalizeMemoryFileName(file_name) {
    return file_name.trim().replace(/\.md$/i, "");
}
// 启发式关键词（兜底参考信号，非硬拦截）。仅在 predict 失败的 fail-open 路径下用于记录提示。
const heuristicOneShot = (args, type) => {
    if (type !== "project")
        return false;
    const fnMarkers = ["workflow", "execution_trace", "_status", "subtask", "progress", "snapshot", "run_", "_run", "exec"];
    const nameMarkers = ["执行轨迹", "工作流执行", "工作流运行", "运行日志", "执行记录", "运行状态", "执行状态", "进度", "阻塞", "受阻", "暂停", "运行快照", "任务快照"];
    const markerText = [args.file_name, args.name, args.description ?? ""].join("\n").toLowerCase();
    const fnHit = fnMarkers.some((m) => markerText.includes(m));
    const nameHit = nameMarkers.some((m) => markerText.toLowerCase().includes(m.toLowerCase()));
    return fnHit && nameHit;
};
function sameTrimmed(a, b) {
    return (a ?? "").trim() === (b ?? "").trim();
}
/**
 * 判断一条待保存记忆在落盘前应如何处理。
 *
 * 返回决策说明：
 *  - skip:    同 file_name + 内容完全相同 -> 不重复写入
 *  - refuse:  内容已存在于其它 file_name，且判定为应合并 -> 返回规范 file_name，拒绝新建
 *  - block:   判定为一次性运行日志 -> 拒绝保存
 *  - proceed: 正常保存（含同 file_name 内容变化视为更新；接口失败 fail-open 路径）
 *
 * state 用于调用方/埋点回读判定是否命中接口。
 */
export async function judgeMemorySave(existing, args) {
    const file_name = normalizeMemoryFileName(args.file_name);
    const content = (args.content ?? "").trim();
    const state = { blockHit: false, mergeHit: false };
    // 1) 内容为空校验的完全去重：同文件同内容直接跳过
    if (content !== "") {
        for (const mem of existing) {
            if (normalizeMemoryFileName(mem.fileName) === file_name && sameTrimmed(mem.content, content)) {
                return { decision: { action: "skip" }, state };
            }
        }
    }
    // 2) 尝试接口判定：是否一次性运行日志（block）
    const blockNoul = await predictNoul({
        key: "block",
        instructions: `判断以下记忆内容是否为"一次性运行日志/临时任务快照"——例如单次工作流执行轨迹、子任务执行进度、` +
            `当前阻塞/受阻状态、临时运行状态文件。这类内容随任务结束立即失效、跨会话无复用价值，应拒绝保存。` +
            `记忆中若提炼出与具体任务无关的稳定规则/判定标准/方法论，则并非一次性日志，应保留。`,
        state: { file_name: file_name, name: args.name, type: args.type, description: args.description ?? "", content: args.content ?? "" },
    });
    if (blockNoul === null) {
        // 接口失败 -> fail-open 放行；仅用启发式记录一个提示信号（不阻断）
        const heuristicBlock = heuristicOneShot(args, args.type);
        log.warn(`[memorySaveGuard] predict 不可用，fail-open 放行；启发式疑似一次性日志=${heuristicBlock}`, args.file_name);
        state.blockHit = heuristicBlock;
    }
    else if (noulToBool(blockNoul)) {
        state.blockHit = true;
        return { decision: { action: "block", reason: "一次性运行日志/临时任务快照" }, state };
    }
    // 3) 内容已存在于其它 file_name 时，接口判定是否应合并（refuse）还是视为更新放行（proceed）
    const existingOther = existing.find((mem) => normalizeMemoryFileName(mem.fileName) !== file_name && sameTrimmed(mem.content, content));
    if (existingOther) {
        const canonicalFile = normalizeMemoryFileName(existingOther.fileName);
        const mergeNoul = await predictNoul({
            key: "merge",
            instructions: `下面的记忆内容即将以新文件名保存，但完全一致的内容已存在于文件"${canonicalFile}"中。` +
                `判断"是否应将该保存合并到 ${canonicalFile}（而不新建一个重复文件，即使文件名/类型/名称不同）"。` +
                `同一内容不应以两个文件重复落盘；若确为需要独立维护的并列条目（例如同名方法在不同模块的独立记录），则不应合并。`,
            state: { file_name: file_name, canonical_file: canonicalFile, name: args.name, type: args.type, content: args.content ?? "" },
        });
        if (mergeNoul === null) {
            // 接口失败 -> fail-open 放行（不强制合并，避免误删）
            log.warn(`[memorySaveGuard] predict 不可用，内容重复但 fail-open 放行`, { file_name, canonicalFile });
        }
        else if (noulToBool(mergeNoul)) {
            state.mergeHit = true;
            return { decision: { action: "refuse", canonicalFile }, state };
        }
    }
    return { decision: { action: "proceed" }, state };
}
