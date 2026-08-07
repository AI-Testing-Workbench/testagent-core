import { type RecalledMemory } from "../recall.js";
/**
 * 归一化向量。写入和搜索时必须使用相同归一化方式。
 * 归一化后向量模长为 1，余弦距离退化为 1 - 内积，是 sqlite-vec 的前置条件。
 */
export declare function normalizeVector(vec: number[]): Float32Array;
export declare class EmbeddingService {
    private buildQueryPrompt;
    /**
     * 单个文本生成向量
     * @param text 待向量化文本
     * @returns 浮点向量数组
     */
    getSingleEmbedding(text: string): Promise<number[]>;
    /**
     * 批量文本生成向量（推荐入库使用，减少请求）
     * @param texts 文本数组
     * @returns 按输入顺序对应的向量数组
     */
    getBatchEmbedding(texts: string[]): Promise<number[][]>;
    /**
     * 记忆召回主方法
     * 参考vectorfilter方法的签名和实现
     * @param worktree 工作树路径
     * @param sessionID 会话ID
     * @param query 用户提问文本
     * @param alreadySurfaced 已展示的记忆集合
     * @param topNum 返回前N条
     * @param minScore 最小匹配分数（默认0.18）
     * @returns 召回的记忆列表
     */
    retrieveMemory(worktree: string, sessionID: string, query: string, alreadySurfaced: ReadonlySet<string> | undefined, topNum: number, minScore?: number): Promise<RecalledMemory[]>;
}
