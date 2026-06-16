import { type LLMClient } from "./recall-llm-adapter.js";
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
export declare function recallRelevantMemoriesKeyWord(worktree: string, sessionID: string, query?: string, alreadySurfaced?: ReadonlySet<string>, recentTools?: readonly string[], maxResults?: number): RecalledMemory[];
export declare function formatRecalledMemories(memories: RecalledMemory[]): string;
export declare function recallRelevantMemoriesByLLM(llm: LLMClient, sessionID: string, worktree: string, query: string, memories: RecalledMemory[], model?: {
    providerID: string;
    modelID: string;
}): Promise<RecalledMemory[]>;
/**
 * （关键词 + 向量）混合检索
 * @param worktree
 * @param sessionID
 * @param query
 * @param alreadySurfaced
 * @param maxResults
 * @returns
 */
export declare function searchHybrid(worktree: string, sessionID: string, query: string, alreadySurfaced: ReadonlySet<string>, maxResults?: number): Promise<RecalledMemory[]>;
