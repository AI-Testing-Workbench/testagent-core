import { join, dirname } from "path";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import * as log from "./log.js";
import { buildAutoExtractionPromptForCmd, AUTO_TREAM_PROMPT } from "../prompt.js";
import { getOpencodeConfigCommands, getSkillsDir, getGlobalSkillsDir, ensureDir } from "../paths.js";
import { config } from "./config.js";
// 命令元数据
function buildCommandFrontmatter(description, agent, subtask, prompt) {
    return `---\ndescription: ${description}\nagent: ${agent}\nsubtask: ${subtask}\n---\n\n${prompt}`;
}
// 初始化记忆相关的命令
// workspaceOpen：是否已打开工作区。未打开时不在项目目录下创建任何文件。
export async function initMemCmd(projectPath, workspaceOpen = true) {
    try {
        const cmdDir = getOpencodeConfigCommands();
        //log.info(`[initMemCmd] cmdDir: ${cmdDir}`);
        initAutoDreamCmd(cmdDir);
        // 只有打开了工作区才在项目目录下创建/删除 memory 命令
        if (!workspaceOpen || !projectPath) {
            log.info(`[initMemCmd] no workspace open, skip project memory command`);
            return "skip";
        }
        initAutoMemoryCmd(projectPath);
    }
    catch (e) {
        log.error("[initMemCmd] error:", e);
    }
}
// 记忆自动提取命令
function initAutoMemoryCmd(projectPath) {
    try {
        // 是否初始化memory命令：true 新增 false 删除
        const memoryEnable = config().enable && config().cmd.memory;
        const memoryCmdFileName = "memory.md";
        // 注意：这里直接用 join 拼接路径，避免在禁用/删除场景调用 getProjectCommandsDir 而创建目录
        const filePath = join(projectPath, ".testagent", "commands", memoryCmdFileName);
        if (memoryEnable) {
            return addAutoMemoryCmd(filePath, projectPath);
        }
        return removeAutoMemoryCmd(filePath);
    }
    catch (e) {
        log.error("initAutoMemoryCmd error:", e);
        return "fail";
    }
}
function addAutoMemoryCmd(filePath, projectPath) {
    if (existsSync(filePath)) {
        log.info(`[initMemCmd] memory command is exists`);
        return "memory cmd is exists";
    }
    const skillsDir = getSkillsDir(projectPath);
    const globalskillsDir = getGlobalSkillsDir();
    const fileContent = buildCommandFrontmatter("extract memory from conversation", "build", false, buildAutoExtractionPromptForCmd(skillsDir, globalskillsDir));
    // 仅在真正写入时才创建 .testagent/commands 目录
    ensureDir(dirname(filePath));
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
