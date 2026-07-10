export type BuildMemorySystemPromptOptions = {
    includeIndex?: boolean;
};
export declare function buildMemorySystemPrompt(worktree: string, recalledMemoriesSection?: string, isLoadSystemPrompt?: boolean, options?: BuildMemorySystemPromptOptions): string;
export declare function buildAutoExtractionPrompt(skillsDir: string, globalskillsDir?: string): string;
export declare function buildAutoExtractionPromptForCmd(skillsDir: string, globalskillsDir?: string): string;
export declare const AUTO_TREAM_PROMPT: string;
export declare const AUTO_PERSONAL_PROMPT: string;
