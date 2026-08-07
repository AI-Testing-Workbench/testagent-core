import { type RecalledMemory } from "./recall.js";
export declare const DEFAULT_MIN_SCORE = 0.18;
export declare function cosineSimilarity(vec1: number[], vec2: number[]): number;
export declare function calcKeywordBonus(query: string, text: string, queryTokens: string[], textTokens: string[]): number;
export declare function calcSubstringBonus(query: string, text: string, queryTokens: string[], textTokens: string[]): number;
export declare function calcPrefixBonus(query: string, text: string, queryTokens: string[], textTokens: string[]): number;
export declare function calcNgramBonus(query: string, text: string, queryTokens: string[], textTokens: string[]): number;
export declare function calcTimeBonus(now: number, mtimeMs: number): number;
/**
 * 构建语料库统计信息（用于 BM25 计算）
 * @param allDocTokens 所有文档的 token 列表
 * @returns 语料库统计对象
 */
export declare function buildCorpusStats(allDocTokens: string[][]): {
    docCount: number;
    docFreq: Map<string, number>;
    avgDocLength: number;
};
/**
 * 计算 BM25 关键词匹配得分
 * BM25 公式：score = IDF(q) * (TF(q) * (K1 + 1)) / (TF(q) + K1 * (1 - B + B * |doc|/avgdl))
 *
 * @param queryTokens 查询词的 token 列表
 * @param textTokens 当前文档的 token 列表
 * @param corpusStats 语料库统计信息（包含文档频率、平均文档长度等）
 * @returns BM25 得分 [0, KEYWORD_BONUS]
 */
export declare function calcBm25KeywordBonus(queryTokens: string[], textTokens: string[], corpusStats?: {
    docCount: number;
    docFreq: Map<string, number>;
    avgDocLength: number;
}): number;
export declare function vectorfilter(worktree: string, sessionID: string, query: string, alreadySurfaced: ReadonlySet<string> | undefined, topNum: number, minScore?: number): Promise<RecalledMemory[]>;
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
