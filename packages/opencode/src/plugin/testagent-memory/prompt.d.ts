export type BuildMemorySystemPromptOptions = {
    includeIndex?: boolean;
};
export declare function buildMemorySystemPrompt(worktree: string, recalledMemoriesSection?: string, isLoadSystemPrompt?: boolean, options?: BuildMemorySystemPromptOptions): string;
export declare const AUTO_EXTRACTION_PROMPT: string;
export declare const AUTO_EXTRACTION_PROMPT_FOR_CDMD: string;
export declare const AUTO_TREAM_PROMPT: string;
export declare const AUTO_PERSONAL_PROMPT: string;
