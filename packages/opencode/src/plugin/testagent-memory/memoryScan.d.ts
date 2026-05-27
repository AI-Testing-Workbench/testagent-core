import type { MemoryType } from "./memory.js";
export type MemoryHeader = {
    filename: string;
    filePath: string;
    mtimeMs: number;
    name: string | null;
    description: string | null;
    type: MemoryType | undefined;
};
/**
 * Recursive scan of memory directory. Reads only frontmatter (first N lines),
 * returns headers sorted by mtime desc, capped at MAX_MEMORY_FILES.
 * Port of Claude Code's scanMemoryFiles().
 */
export declare function scanMemoryFiles(memoryDir: string): MemoryHeader[];
export declare function formatMemoryManifest(memories: MemoryHeader[]): string;
export declare function getMemoryManifest(worktree: string): {
    headers: MemoryHeader[];
    manifest: string;
};
