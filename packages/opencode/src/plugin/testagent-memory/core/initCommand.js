import { join } from "path";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import * as log from "./log.js";
import { AUTO_EXTRACTION_PROMPT_FOR_CDMD, AUTO_TREAM_PROMPT } from "../prompt.js";
import { getOpencodeConfigCommands } from "../paths.js";
import { config } from "./config.js";
// 命令元数据
function buildCommandFrontmatter(description, agent, subtask, prompt) {
    return `---\ndescription: ${description}\nagent: ${agent}\nsubtask: ${subtask}\n---\n\n${prompt}`;
}
// 初始化记忆相关的命令
export async function initMemCmd() {
    try {
        const cmdDir = getOpencodeConfigCommands();
        //log.info(`[initMemCmd] cmdDir: ${cmdDir}`);
        initAutoDreamCmd(cmdDir);
        initAutoMemoryCmd(cmdDir);
    }
    catch (e) {
        log.error("[initMemCmd] error:", e);
    }
}
// 记忆自动提取命令
function initAutoMemoryCmd(cmdDir) {
    try {
        const memoryCmdFileName = "memory.md";
        const filePath = join(cmdDir, memoryCmdFileName);
        // 是否初始化memory命令：true 新增 false 删除
        const memoryEnable = config().enable && config().cmd.memory;
        if (memoryEnable) {
            return addAutoMemoryCmd(filePath);
        }
        else {
            return removeAutoMemoryCmd(filePath);
        }
    }
    catch (e) {
        log.error("initAutoMemoryCmd error:", e);
        return "fail";
    }
}
function addAutoMemoryCmd(filePath) {
    if (existsSync(filePath)) {
        log.info(`[initMemCmd] memory command is exists`);
        return "memory cmd is exists";
    }
    const fileContent = buildCommandFrontmatter("extract memory from conversation", "build", false, AUTO_EXTRACTION_PROMPT_FOR_CDMD);
    writeFileSync(filePath, fileContent, "utf-8");
    log.info(`[initMemCmd] memory command is init`);
    return "add ok";
}
function removeAutoMemoryCmd(filePath) {
    if (existsSync(filePath)) {
        unlinkSync(filePath);
        log.info(`[initMemCmd] memory command is remove`);
    }
    return "remove ok";
}
// 记忆自动整理命令
function initAutoDreamCmd(cmdDir) {
    try {
        const memoryCmdFileName = "dream.md";
        const filePath = join(cmdDir, memoryCmdFileName);
        // 是否初始化memory命令：true 新增 false 删除
        const dreamEnable = config().enable && config().cmd.dream;
        if (dreamEnable) {
            return addAutoDreamCmd(filePath);
        }
        else {
            return removeAutoDreamCmd(filePath);
        }
    }
    catch (e) {
        log.error("initAutoMemoryCmd error:", e);
        return "fail";
    }
}
function addAutoDreamCmd(filePath) {
    if (existsSync(filePath)) {
        log.info(`[initMemCmd] dream command is exists`);
        return "dream cmd is exists";
    }
    const fileContent = buildCommandFrontmatter("consolidate memory", "auto-dream", true, AUTO_TREAM_PROMPT);
    writeFileSync(filePath, fileContent, "utf-8");
    log.info(`[initMemCmd] dream command is init`);
    return "ok";
}
function removeAutoDreamCmd(filePath) {
    if (existsSync(filePath)) {
        unlinkSync(filePath);
        log.info(`[initMemCmd] dream command is remove`);
    }
    return "remove ok";
}
