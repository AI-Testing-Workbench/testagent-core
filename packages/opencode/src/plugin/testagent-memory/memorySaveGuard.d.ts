export type MemorySaveGuardDecision = {
    action: "proceed";
} | {
    action: "skip";
} | {
    action: "refuse";
    canonicalFile: string;
} | {
    action: "block";
    reason?: string;
};
export interface MemorySaveGuardArgs {
    file_name: string;
    name: string;
    type: string;
    description?: string;
    content?: string;
}
export interface MemorySaveGuardExisting {
    fileName: string;
    name?: string;
    description?: string;
    content?: string;
}
export declare function normalizeMemoryFileName(file_name: string): string;
export type MemorySaveGuardState = {
    blockHit: boolean;
    mergeHit: boolean;
};
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
export declare function judgeMemorySave(existing: MemorySaveGuardExisting[], args: MemorySaveGuardArgs): Promise<{
    decision: MemorySaveGuardDecision;
    state: MemorySaveGuardState;
}>;
