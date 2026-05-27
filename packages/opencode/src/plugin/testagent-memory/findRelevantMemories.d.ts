import { type LLMClient } from "./recall-llm-adapter.js";
import { type RecalledMemory } from "./recall.js";
export declare function findRelevantMemories(llm: LLMClient, sessionID: string, worktree: string, query: string, isLLmRecall: boolean | undefined, alreadySurfaced: ReadonlySet<string>, recentTools: readonly string[], model?: {
    providerID: string;
    modelID: string;
}): Promise<RecalledMemory[]>;
