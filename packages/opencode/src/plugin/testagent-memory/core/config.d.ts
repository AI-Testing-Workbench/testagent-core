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
        /** 记忆提取每次从数据库读取的记录数 */
        autoExtractBatchSize: z.ZodDefault<z.ZodNumber>;
        autoExtractBatchToken: z.ZodDefault<z.ZodNumber>;
        /** 是否提取个人全局记忆 */
        personalMemoryEnable: z.ZodDefault<z.ZodBoolean>;
        personalMemoryPrompt: z.ZodDefault<z.ZodString>;
        /** 控制是否开启自动整理 */
        autoDreamEnable: z.ZodDefault<z.ZodBoolean>;
        /** 控制是否开启自动提取 */
        autoExtractEnable: z.ZodDefault<z.ZodBoolean>;
        personalMemoryBackupSize: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        autoExtractMaxLength: number;
        autoExtractBufferSize: number;
        autoExtractBatchSize: number;
        autoExtractBatchToken: number;
        personalMemoryEnable: boolean;
        personalMemoryPrompt: string;
        autoDreamEnable: boolean;
        autoExtractEnable: boolean;
        personalMemoryBackupSize: number;
    }, {
        autoExtractMaxLength?: number | undefined;
        autoExtractBufferSize?: number | undefined;
        autoExtractBatchSize?: number | undefined;
        autoExtractBatchToken?: number | undefined;
        personalMemoryEnable?: boolean | undefined;
        personalMemoryPrompt?: string | undefined;
        autoDreamEnable?: boolean | undefined;
        autoExtractEnable?: boolean | undefined;
        personalMemoryBackupSize?: number | undefined;
    }>>;
    recall: z.ZodDefault<z.ZodObject<{
        recallEnable: z.ZodDefault<z.ZodBoolean>;
        /** 是否使用模型进行语义分析召回，false：仅使用向量分析召回 */
        llmRecall: z.ZodDefault<z.ZodBoolean>;
        /** 使用llm召回记忆超时时间 */
        llmRecallTimeout: z.ZodDefault<z.ZodNumber>;
        providerID: z.ZodDefault<z.ZodString>;
        modelID: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        recallEnable: boolean;
        llmRecall: boolean;
        llmRecallTimeout: number;
        providerID: string;
        modelID: string;
    }, {
        recallEnable?: boolean | undefined;
        llmRecall?: boolean | undefined;
        llmRecallTimeout?: number | undefined;
        providerID?: string | undefined;
        modelID?: string | undefined;
    }>>;
    trace: z.ZodDefault<z.ZodObject<{
        enable: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        enable: boolean;
    }, {
        enable?: boolean | undefined;
    }>>;
    /** question工具调用时，是否注入相似答案 */
    similarAnswer: z.ZodDefault<z.ZodObject<{
        enable: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        enable: boolean;
    }, {
        enable?: boolean | undefined;
    }>>;
    /** 子Agent默认使用的模型配置 */
    subAgentModel: z.ZodDefault<z.ZodObject<{
        providerID: z.ZodDefault<z.ZodString>;
        modelID: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        providerID: string;
        modelID: string;
    }, {
        providerID?: string | undefined;
        modelID?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    memory: {
        autoExtractMaxLength: number;
        autoExtractBufferSize: number;
        autoExtractBatchSize: number;
        autoExtractBatchToken: number;
        personalMemoryEnable: boolean;
        personalMemoryPrompt: string;
        autoDreamEnable: boolean;
        autoExtractEnable: boolean;
        personalMemoryBackupSize: number;
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
        llmRecallTimeout: number;
        providerID: string;
        modelID: string;
    };
    trace: {
        enable: boolean;
    };
    similarAnswer: {
        enable: boolean;
    };
    subAgentModel: {
        providerID: string;
        modelID: string;
    };
}, {
    memory?: {
        autoExtractMaxLength?: number | undefined;
        autoExtractBufferSize?: number | undefined;
        autoExtractBatchSize?: number | undefined;
        autoExtractBatchToken?: number | undefined;
        personalMemoryEnable?: boolean | undefined;
        personalMemoryPrompt?: string | undefined;
        autoDreamEnable?: boolean | undefined;
        autoExtractEnable?: boolean | undefined;
        personalMemoryBackupSize?: number | undefined;
    } | undefined;
    enable?: boolean | undefined;
    debug?: boolean | undefined;
    cmd?: {
        memory?: boolean | undefined;
        dream?: boolean | undefined;
    } | undefined;
    recall?: {
        recallEnable?: boolean | undefined;
        llmRecall?: boolean | undefined;
        llmRecallTimeout?: number | undefined;
        providerID?: string | undefined;
        modelID?: string | undefined;
    } | undefined;
    trace?: {
        enable?: boolean | undefined;
    } | undefined;
    similarAnswer?: {
        enable?: boolean | undefined;
    } | undefined;
    subAgentModel?: {
        providerID?: string | undefined;
        modelID?: string | undefined;
    } | undefined;
}>;
export type MemoryConfig = z.infer<typeof MemoryConfig>;
export declare function config(): MemoryConfig;
export declare function load(directory: string): Promise<MemoryConfig>;
