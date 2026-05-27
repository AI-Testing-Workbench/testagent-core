export type BufferedMessage = {
    role: string;
    content: string;
    timestamp: number;
};
/** 自动提取和整理 模型 */
export type AutoMemoModel = {
    providerID: string;
    modelID: string;
};
export declare class MessageBuffer {
    private messages;
    push(msg: BufferedMessage): void;
    drain(): BufferedMessage[];
    get size(): number;
    peek(): BufferedMessage[];
    clear(): void;
}
