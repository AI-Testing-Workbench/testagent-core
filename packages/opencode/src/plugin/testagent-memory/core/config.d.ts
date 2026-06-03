import { z } from "zod";
export declare const MemoryConfig: z.ZodObject<{
    enable: z.ZodDefault<z.ZodBoolean>;
    /** 是否开启调试，打印详细日志 */
    debug: z.ZodDefault<z.ZodBoolean>;
    cmd: z.ZodDefault<z.ZodObject<{
        memory: z.ZodDefault<z.ZodBoolean>;
        dream: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        memory: boolean;
        dream: boolean;
    }, {
        memory?: boolean | undefined;
        dream?: boolean | undefined;
    }>>;
    memory: z.ZodDefault<z.ZodObject<{
        /** 记忆提取最大长度 */
        autoExtractMaxLength: z.ZodDefault<z.ZodNumber>;
        /** 记忆提取缓存大小 */
        autoExtractBufferSize: z.ZodDefault<z.ZodNumber>;
        /** 是否提取个人全局记忆 */
        personalMemoryEnable: z.ZodDefault<z.ZodBoolean>;
        personalMemoryPrompt: z.ZodDefault<z.ZodString>;
        /** 控制是否开启自动整理 */
        autoDreamEnable: z.ZodDefault<z.ZodBoolean>;
        /** 控制是否开启自动提取 */
        autoExtractEnable: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        autoExtractMaxLength: number;
        autoExtractBufferSize: number;
        personalMemoryEnable: boolean;
        personalMemoryPrompt: string;
        autoDreamEnable: boolean;
        autoExtractEnable: boolean;
    }, {
        autoExtractMaxLength?: number | undefined;
        autoExtractBufferSize?: number | undefined;
        personalMemoryEnable?: boolean | undefined;
        personalMemoryPrompt?: string | undefined;
        autoDreamEnable?: boolean | undefined;
        autoExtractEnable?: boolean | undefined;
    }>>;
    recall: z.ZodDefault<z.ZodObject<{
        recallEnable: z.ZodDefault<z.ZodBoolean>;
        /** 是否使用模型进行语义分析召回，false：仅使用向量分析召回 */
        llmRecall: z.ZodDefault<z.ZodBoolean>;
        /** 使用llm召回记忆超时时间 */
        providerID: z.ZodString;
        modelID: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        recallEnable: boolean;
        llmRecall: boolean;
        providerID: string;
        modelID: string;
    }, {
        providerID: string;
        modelID: string;
        recallEnable?: boolean | undefined;
        llmRecall?: boolean | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    memory: {
        autoExtractMaxLength: number;
        autoExtractBufferSize: number;
        personalMemoryEnable: boolean;
        personalMemoryPrompt: string;
        autoDreamEnable: boolean;
        autoExtractEnable: boolean;
    };
    enable: boolean;
    debug: boolean;
    cmd: {
        memory: boolean;
        dream: boolean;
    };
    recall: {
        recallEnable: boolean;
        llmRecall: boolean;
        providerID: string;
        modelID: string;
    };
}, {
    memory?: {
        autoExtractMaxLength?: number | undefined;
        autoExtractBufferSize?: number | undefined;
        personalMemoryEnable?: boolean | undefined;
        personalMemoryPrompt?: string | undefined;
        autoDreamEnable?: boolean | undefined;
        autoExtractEnable?: boolean | undefined;
    } | undefined;
    enable?: boolean | undefined;
    debug?: boolean | undefined;
    cmd?: {
        memory?: boolean | undefined;
        dream?: boolean | undefined;
    } | undefined;
    recall?: {
        providerID: string;
        modelID: string;
        recallEnable?: boolean | undefined;
        llmRecall?: boolean | undefined;
    } | undefined;
}>;
export type MemoryConfig = z.infer<typeof MemoryConfig>;
export declare function config(): MemoryConfig;
export declare function load(directory: string): Promise<MemoryConfig>;
