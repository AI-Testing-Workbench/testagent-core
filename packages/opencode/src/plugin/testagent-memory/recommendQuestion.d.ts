/**
 * 二次判定：调用 predict 接口比较用户问题与推荐问题是否为同一个问题。
 * @returns true: noul>阈值 认定为同一问题；false: 非同一问题；
 *          null: 接口不可访问/响应异常（调用方跳过接口调用，保留既有推荐）
 */
export declare function sameQuestionCheck(query: string, recommendedQuestion: string): Promise<boolean | null>;
export declare function extractAnswersByQuestion(content: string | null): Array<{
    question: string;
    answer: string;
}>;
export declare function buildQuestionContent(input: Record<string, unknown> | undefined, outputText: string | null): string;
export declare function extractQuestionText(input: Record<string, unknown> | undefined): string | null;
export declare function extractAnswerText(content: string | null): string | null;
export declare function extractQuestionFromContent(content: string | null): string | null;
export interface RecommendQuestionOption {
    label: string;
    description?: string;
}
export interface RecommendQuestion {
    question?: string;
    options?: RecommendQuestionOption[];
}
export interface RecommendQuestionArgs {
    questions?: RecommendQuestion[];
}
export interface RecommendRec {
    qi: number;
    answer: string;
}
/**
 * 推荐问题答案：根据用户本次问题，从历史问答候选（关键词+向量 RRF 融合）中选择最相似
 * 的一条，并通过 predict 接口做二次判定（noul>0.7 认定为同一问题）后才注入推荐。
 *
 * 该函数会原地修改 args（把推荐答案选项置顶/插入），返回推荐记录列表供调用方跟踪。
 * 所有内部异常均被捕获并记录日志，不会向调用方抛出。
 */
export declare function recommendQuestionAnswers(params: {
    callID: string;
    sessionID: string;
    projectPath: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    args: RecommendQuestionArgs;
}): Promise<RecommendRec[]>;
