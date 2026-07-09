import type { LLMClient } from "./core/types.js";
export declare function runAutoDream(input: {
    llm: LLMClient;
    projectPath: string;
    sessionID: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    /** Skip minMessages threshold check — distill whatever is pending */
    force?: boolean;
    options?: {
        eventSource?: string;
    };
}): Promise<void>;
