import { type MemoryHeader } from "./memoryScan.js";
export declare const DEFAULT_MIN_SCORE = 0.18;
export declare function cosineSimilarity(vec1: number[], vec2: number[]): number;
export declare function vectorfilter(worktree: string, sessionID: string, query: string, alreadySurfaced: ReadonlySet<string> | undefined, topNum: number, minScore?: number): Promise<MemoryHeader[]>;
export interface ClaudeProfileMatch {
    /** 章节名称，如"基本信息"、"偏好" */
    sectionName: string;
    /** 章节原始内容 */
    content: string;
    /** 匹配分数 */
    score: number;
    /** 匹配到的关键词 */
    matchedKeywords: string[];
    /** 匹配到的关键词在内容中的位置信息 */
    keywordPositions?: Array<{
        keyword: string;
        position: number;
    }>;
}
/**
 * 从 CLAUDE.md 文件中提取与查询相关的内容
 * @param query 查询词
 * @param filePath CLAUDE.md 文件路径，默认为 ~/.config/testagent/CLAUDE.md
 * @param minScore 匹配系数阈值，低于此分数的结果将被过滤
 * @param topNum 返回结果数量上限，默认为 10
 * @returns 匹配的内容列表，按匹配分数降序排列
 */
export declare function extractClaudeContent(query: string, filePath: string, minScore?: number, topNum?: number): ClaudeProfileMatch[];
