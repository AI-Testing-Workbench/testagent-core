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
export declare function saveMemory(worktree: string, fileName: string, name: string, description: string, type: MemoryType, content: string): string;
export declare function deleteMemory(worktree: string, fileName: string): boolean;
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
export type EntrypointTruncation = {
    content: string;
    lineCount: number;
    byteCount: number;
    wasLineTruncated: boolean;
    wasByteTruncated: boolean;
};
export declare function truncateEntrypoint(raw: string): EntrypointTruncation;
