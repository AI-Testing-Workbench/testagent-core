/** Embedding 单条返回结构 */
export interface EmbeddingData {
    object: "embedding";
    index: number;
    embedding: number[];
}
/** Embedding 接口返回整体 */
export interface EmbeddingResponse {
    object: "list";
    data: EmbeddingData[];
    model: string;
    usage: {
        prompt_tokens: number;
    };
}
