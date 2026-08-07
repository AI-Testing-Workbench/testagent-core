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
export declare function recallRelevantMemoriesKeyWord(worktree: string, sessionID: string, partId: string, messageId: string, query?: string, alreadySurfaced?: ReadonlySet<string>, recentTools?: readonly string[], maxResults?: number): Promise<RecalledMemory[]>;
export declare function formatRecalledMemories(memories: RecalledMemory[]): string;
export declare function recallRelevantMemoriesByLLM(llm: LLMClient, sessionID: string, partId: string, messageId: string, worktree: string, query: string, memories: RecalledMemory[], model?: {
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
export declare function searchHybrid(worktree: string, sessionID: string, partId: string, messageId: string, query: string, alreadySurfaced: ReadonlySet<string>, maxResults?: number): Promise<RecalledMemory[]>;
export type RecallMetrics = {
    sessionID: string;
    partId: string;
    messageId: string;
    userQuery: string;
    op_type: string;
    hybridRecallSuccess?: string;
    hybridRecallCount?: number;
    hybridRecallMemories?: {
        name: string;
        type: string;
        description: string;
    }[];
    hybridRecallStartTime?: Date;
    hybridRecallEndTime?: Date;
    hybridRecallTime?: number;
    llmRecallEnabled: boolean;
    llmRecallModel?: string;
    llmRecallSuccess?: string;
    llmRecallCount?: number;
    llmRecallMemories?: {
        name: string;
        type: string;
        description: string;
    }[];
    llmRecallStartTime?: Date;
    llmRecallEndTime?: Date;
    llmRecallTime?: number;
    llmRecallError?: string;
    finalRecallSuccess?: string;
    finalRecallCount?: number;
    finalRecallMemories?: {
        name: string;
        type: string;
        description: string;
    }[];
    finalRecallStartTime?: Date;
    finalRecallEndTime?: Date;
    finalRecallTime?: number;
    finalRecallError?: string;
};
/** 带时区偏移的当前时间（东八区） */
export declare function nowWithTz(): Date;
/**
 * 记录混合检索阶段成功指标
 */
export declare function recordHybridMetrics(metrics: RecallMetrics, memories: RecalledMemory[], startTime: Date): void;
/**
 * 记录 LLM 召回阶段成功指标
 */
export declare function recordLlmSuccess(metrics: RecallMetrics, memories: RecalledMemory[], startTime: Date): void;
/**
 * 记录 LLM 召回阶段失败指标
 */
export declare function recordLlmFailure(metrics: RecallMetrics, error: unknown, startTime: Date): void;
/**
 * 记录最终召回结果成功指标
 */
export declare function recordFinalSuccess(metrics: RecallMetrics, memories: RecalledMemory[], startTime: Date): void;
/**
 * 记录最终召回结果失败指标
 */
export declare function recordFinalFailure(metrics: RecallMetrics, error: unknown, startTime: Date): void;
export declare function logRecallMetrics(metrics: RecallMetrics): void;
