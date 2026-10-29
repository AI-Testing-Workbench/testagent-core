export interface PredictNoulParams {
    /** noul 判定问题键（如 "same"），对应响应 answers.<key>.noul */
    key: string;
    /** 语义判定指令，例如 `query和'${x}'是否语义相似` */
    instructions: string;
    /** 可选的其它 state 初值，默认为 {} */
    state?: Record<string, unknown>;
}
/**
 * 调用 predict 接口执行 noul 语义判定。
 * @returns noul 数值（0~1，≥0 有效）；接口不可访问/非200/响应缺字段/超时时返回 null。
 *          返回 null 表示接口调用失败，由调用方决定兜底行为。
 */
export declare function predictNoul(params: PredictNoulParams): Promise<number | null>;
/** 便捷：noul > threshold 判定布尔 */
export declare function noulToBool(noul: number, threshold?: number): boolean;
