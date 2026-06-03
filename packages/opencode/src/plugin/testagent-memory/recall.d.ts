export type RecalledMemory = {
    fileName: string;
    filePath: string;
    name: string;
    type: string;
    description: string;
    content: string;
    ageInDays: number;
};
export declare function readMemoryContent(filePath: string): string;
export declare function truncateMemoryContent(content: string): string;
export declare function recallRelevantMemories(worktree: string, query?: string, alreadySurfaced?: ReadonlySet<string>, recentTools?: readonly string[]): RecalledMemory[];
export declare function formatRecalledMemories(memories: RecalledMemory[]): string;
