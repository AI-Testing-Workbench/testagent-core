import { workerSessionIDs } from "./core/worker.js";
import type { LLMClient } from "./core/types.js";
import { MessageBuffer } from "./core/messageBuffer.js";
export { workerSessionIDs };
export declare function run(input: {
    llm: LLMClient;
    projectPath: string;
    sessionID: string;
    buffer: MessageBuffer;
    model?: {
        providerID: string;
        modelID: string;
    };
    /** Skip minMessages threshold check — distill whatever is pending */
    force?: boolean;
}): Promise<{
    rounds: number;
    distilled: number;
}>;
