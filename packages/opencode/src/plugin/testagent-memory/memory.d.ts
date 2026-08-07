export declare const MEMORY_TYPES: readonly ["user", "feedback", "project", "reference"];
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryEntry = {
    filePath: string;
    fileName: string;
    name: string;
    description: string;
    type: MemoryType;
    content: string;
    rawContent: string;
};
export declare function listMemories(worktree: string): MemoryEntry[];
export declare function readMemory(worktree: string, fileName: string): MemoryEntry | null;
export declare function saveMemory(worktree: string, fileName: string, name: string, description: string, type: MemoryType, content: string): Promise<string>;
export declare function deleteMemory(worktree: string, fileName: string): Promise<boolean>;
export declare function searchMemories(worktree: string, query: string): MemoryEntry[];
/**
 * 读取个人全局记忆内容
 * @returns
 */
export declare function readPersonalMemory(): string;
/**
 * 保持个人全局记忆
 * @param content
 * @returns
 */
export declare function savePersonalMemory(content: string): string;
export declare function readIndex(worktree: string): string;
/**
 * 扫描 worktree 下所有记忆文件（不含 MEMORY.md），为没有向量的文件生成并存入向量库
 * 用于存量数据回填，新增记忆由 saveMemory 自动处理
 */
export declare function backfillMemoryVectors(worktree: string): Promise<{
    total: number;
    success: number;
    failed: number;
}>;
export type EntrypointTruncation = {
    content: string;
    lineCount: number;
    byteCount: number;
    wasLineTruncated: boolean;
    wasByteTruncated: boolean;
};
export declare function truncateEntrypoint(raw: string): EntrypointTruncation;
