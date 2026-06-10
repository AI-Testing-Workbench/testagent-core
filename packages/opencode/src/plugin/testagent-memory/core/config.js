import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as log from "./log.js";
// 记忆插件相关配置
export const MemoryConfig = z.object({
    // 是否启用插件，默认关闭，和 VS Code 设置页保持一致
    enable: z.boolean().default(false),
    /** 是否开启调试，打印详细日志 */
    debug: z.boolean().default(false),
    // 是否初始化命令
    cmd: z
        .object({
        // 是否初始化提取命令
        memory: z.boolean().default(true),
        // 是否初始化整理命令
        dream: z.boolean().default(true),
    })
        .default({ memory: true, dream: true }),
    memory: z
        .object({
        /** 记忆提取最大长度 */
        autoExtractMaxLength: z.number().default(10000),
        /** 记忆提取缓存大小 */
        autoExtractBufferSize: z.number().default(10),
        /** 是否提取个人全局记忆 */
        personalMemoryEnable: z.boolean().default(true),
        personalMemoryPrompt: z.string().default(""),
        /** 控制是否开启自动整理 */
        autoDreamEnable: z.boolean().default(true),
        /** 控制是否开启自动提取 */
        autoExtractEnable: z.boolean().default(true),
    })
        .default({ autoExtractMaxLength: 10000, autoExtractBufferSize: 10, personalMemoryEnable: true,
        personalMemoryPrompt: "", autoDreamEnable: true, autoExtractEnable: true }),
    recall: z
        .object({
        recallEnable: z.boolean().default(true),
        /** 是否使用模型进行语义分析召回，false：仅使用向量分析召回 */
        llmRecall: z.boolean().default(false),
        /** 使用llm召回记忆超时时间 */
        //recallTimeout: z.number().default(10000),
        providerID: z.string(),
        modelID: z.string(),
    })
        .default({ recallEnable: true, llmRecall: false, providerID: "", modelID: "" }),
});
let current = MemoryConfig.parse({});
// 获取配置
export function config() {
    return current;
}
// 加载配置
export async function load(directory) {
    try {
        const path = join(directory, "testagent-memory.json");
        if (existsSync(path)) {
            const fileTxt = readFileSync(path, "utf8");
            const raw = JSON.parse(isBlank(fileTxt) ? "{}" : fileTxt);
            current = MemoryConfig.parse(raw);
            log.info("load memory config from file");
            //log.info(`config1= ${JSON.stringify(current)}`);
            return current;
        }
        current = MemoryConfig.parse({});
        log.info("load memory config default");
        //log.info(`config2= ${JSON.stringify(current)}`);
        return current;
    }
    catch (e) {
        log.error("load memory config error: ", e);
        current = MemoryConfig.parse({});
        return current;
    }
}
function isBlank(str) {
    return str === null || str === undefined || str.trim() === "";
}
