export type BuildMemorySystemPromptOptions = {
    includeIndex?: boolean;
    /**
     * 本轮是否需要保存/更新/删除记忆。为 true 时才注入"保存指南"
     * （记忆类型 / 切勿保存 / 如何保存，约一半篇幅）。
     * 默认 true 以保持历史行为；主流程用 shouldIncludeSaveGuide() 计算后懒加载。
     */
    needSaveGuide?: boolean;
};
/**
 * 判断本轮是否需要注入保存指南。
 * - hasRecalled：已注入召回记忆时，可能需要用 memory_save/memory_delete 处理失效记忆
 * - query：用户表达保存、偏好或纠正意图时
 */
export declare function shouldIncludeSaveGuide(query?: string, hasRecalled?: boolean): boolean;
export declare function buildMemorySystemPrompt(worktree: string, recalledMemoriesSection?: string, isLoadSystemPrompt?: boolean, options?: BuildMemorySystemPromptOptions): string;
export declare function buildAutoExtractionPrompt(skillsDir: string, globalskillsDir?: string): string;
export declare function buildAutoExtractionPromptForCmd(skillsDir: string, globalskillsDir?: string): string;
/**
 * SDT 记忆提取提示词
 * 用于 sdt-memory-extraction agent，专职测试知识沉淀
 */
export declare function buildSdtMemoryExtractionPrompt(skillsDir: string, globalskillsDir?: string): string;
export declare const AUTO_TREAM_PROMPT: string;
export declare const AUTO_PERSONAL_PROMPT: string;
