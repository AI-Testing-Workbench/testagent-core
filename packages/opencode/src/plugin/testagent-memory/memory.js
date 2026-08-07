import { readFileSync, writeFileSync, readdirSync, unlinkSync, copyFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { getMemoryDir, getMemoryEntrypoint, ENTRYPOINT_NAME, validateMemoryFileName, MAX_MEMORY_FILES, MAX_MEMORY_FILE_BYTES, MAX_ENTRYPOINT_LINES, MAX_ENTRYPOINT_BYTES, FRONTMATTER_MAX_LINES, getPersonalMemoryFile, getPersonalMemoryBackupDir, } from "./paths.js";
import * as log from "./core/log.js";
import { config } from "./core/config.js";
import { getDatabase } from "./core/db.js";
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"];
function parseFrontmatter(raw) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("---")) {
        return { frontmatter: {}, content: trimmed };
    }
    const lines = trimmed.split("\n");
    let closingLineIdx = -1;
    for (let i = 1; i < Math.min(lines.length, FRONTMATTER_MAX_LINES); i++) {
        if (lines[i].trimEnd() === "---") {
            closingLineIdx = i;
            break;
        }
    }
    if (closingLineIdx === -1) {
        return { frontmatter: {}, content: trimmed };
    }
    const endIndex = lines.slice(0, closingLineIdx).join("\n").length + 1;
    const frontmatterBlock = trimmed.slice(3, endIndex).trim();
    const content = trimmed.slice(endIndex + 3).trim();
    const frontmatter = {};
    for (const line of frontmatterBlock.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1)
            continue;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (key && value) {
            frontmatter[key] = value;
        }
    }
    return { frontmatter, content };
}
function buildFrontmatter(name, description, type) {
    return `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---`;
}
function parseMemoryType(raw) {
    if (!raw)
        return undefined;
    return MEMORY_TYPES.find((t) => t === raw);
}
export function listMemories(worktree) {
    const memDir = getMemoryDir(worktree);
    const entries = [];
    let files;
    try {
        files = readdirSync(memDir, { encoding: "utf-8" })
            .filter((f) => f.endsWith(".md") && f !== ENTRYPOINT_NAME)
            .sort()
            .slice(0, MAX_MEMORY_FILES);
    }
    catch {
        return entries;
    }
    for (const fileName of files) {
        const filePath = join(memDir, fileName);
        try {
            const rawContent = readFileSync(filePath, "utf-8");
            const { frontmatter, content } = parseFrontmatter(rawContent);
            entries.push({
                filePath,
                fileName,
                name: frontmatter.name ?? fileName.replace(/\.md$/, ""),
                description: frontmatter.description ?? "",
                type: parseMemoryType(frontmatter.type) ?? "user",
                content,
                rawContent,
            });
        }
        catch {
        }
    }
    return entries;
}
export function readMemory(worktree, fileName) {
    const safeName = validateMemoryFileName(fileName);
    const memDir = getMemoryDir(worktree);
    const filePath = join(memDir, safeName);
    try {
        const rawContent = readFileSync(filePath, "utf-8");
        const { frontmatter, content } = parseFrontmatter(rawContent);
        return {
            filePath,
            fileName: basename(filePath),
            name: frontmatter.name ?? fileName.replace(/\.md$/, ""),
            description: frontmatter.description ?? "",
            type: parseMemoryType(frontmatter.type) ?? "user",
            content,
            rawContent,
        };
    }
    catch {
        return null;
    }
}
export async function saveMemory(worktree, fileName, name, description, type, content) {
    const safeName = validateMemoryFileName(fileName);
    const memDir = getMemoryDir(worktree);
    const filePath = join(memDir, safeName);
    const nameNew = (name !== null && name !== undefined && name !== 'undefined' && name.length > 0) ? name : safeName.replace(/\.md$/, "").replace(/.*\//, "");
    const fileContent = `${buildFrontmatter(nameNew, description, type)}\n\n${content.trim()}\n`;
    if (Buffer.byteLength(fileContent, "utf-8") > MAX_MEMORY_FILE_BYTES) {
        throw new Error(`Memory file content exceeds the ${MAX_MEMORY_FILE_BYTES}-byte limit`);
    }
    writeFileSync(filePath, fileContent, "utf-8");
    updateIndex(worktree, safeName, nameNew, description);
    // 异步生成并存储向量
    try {
        const { EmbeddingService } = await import("./embedding/service.js");
        const provider = new EmbeddingService();
        const vector = await provider.getSingleEmbedding(content.trim());
        const db = await getDatabase();
        db.upsertMemoryVector(safeName, worktree, vector, content.trim());
    }
    catch (e) {
        log.error(`[saveMemory] 向量生成/存储失败: ${safeName}`, e);
    }
    return filePath;
}
export async function deleteMemory(worktree, fileName) {
    const safeName = validateMemoryFileName(fileName);
    const memDir = getMemoryDir(worktree);
    const filePath = join(memDir, safeName);
    try {
        unlinkSync(filePath);
        removeFromIndex(worktree, safeName);
        // 同步删除向量
        try {
            const db = await getDatabase();
            db.deleteMemoryVector(safeName, worktree);
        }
        catch (e) {
            log.error(`[deleteMemory] 向量删除失败: ${safeName}`, e);
        }
        return true;
    }
    catch {
        return false;
    }
}
export function searchMemories(worktree, query) {
    const all = listMemories(worktree);
    const queryTerms = query.split(/\s+/).filter(t => t.length > 0).map(t => t.toLowerCase());
    if (queryTerms.length > 0) {
        return all.filter((entry) => {
            const lowerName = entry.name.toLowerCase();
            const lowerDescription = entry.description.toLowerCase();
            const lowerContent = entry.content.toLowerCase();
            // 所有查询词都必须在 name、description 或 content 中出现（与逻辑）
            return queryTerms.every(term => lowerName.includes(term) ||
                lowerDescription.includes(term) ||
                lowerContent.includes(term));
        });
    }
    return [];
}
/**
 * 读取个人全局记忆内容
 * @returns
 */
export function readPersonalMemory() {
    const memoryFilePath = getPersonalMemoryFile();
    try {
        return readFileSync(memoryFilePath, "utf-8");
    }
    catch {
        return "";
    }
}
/**
 * 保持个人全局记忆
 * @param content
 * @returns
 */
export function savePersonalMemory(content) {
    try {
        const memoryFilePath = getPersonalMemoryFile();
        // 写入前备份到 persona-back/ 目录，轮转保留最近10个
        if (existsSync(memoryFilePath)) {
            const backupDir = getPersonalMemoryBackupDir();
            const now = new Date();
            const fmt = new Intl.DateTimeFormat("en-CA", {
                timeZone: "Asia/Shanghai",
                year: "numeric", month: "2-digit", day: "2-digit",
                hour: "2-digit", minute: "2-digit", second: "2-digit",
                hour12: false,
            });
            const parts = fmt.formatToParts(now);
            const m = Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
            const ts = `${m.year}${m.month}${m.day}_${m.hour}${m.minute}${m.second}`;
            const backupPath = join(backupDir, `PERSONA_${ts}.md`);
            copyFileSync(memoryFilePath, backupPath);
            const files = readdirSync(backupDir, { encoding: "utf-8" })
                .filter(f => f.startsWith("PERSONA_") && f.endsWith(".md"))
                .sort()
                .reverse();
            if (files.length > config().memory.personalMemoryBackupSize) {
                for (const f of files.slice(config().memory.personalMemoryBackupSize)) {
                    unlinkSync(join(backupDir, f));
                }
            }
        }
        writeFileSync(memoryFilePath, content, "utf-8");
        return memoryFilePath;
    }
    catch (e) {
        log.error("savePersonalMemory fail ", e);
        return "个人全局记忆保存失败";
    }
}
export function readIndex(worktree) {
    const entrypoint = getMemoryEntrypoint(worktree);
    try {
        return readFileSync(entrypoint, "utf-8");
    }
    catch {
        return "";
    }
}
function updateIndex(worktree, fileName, name, description) {
    const entrypoint = getMemoryEntrypoint(worktree);
    const existing = readIndex(worktree);
    const lines = existing.split("\n").filter((l) => l.trim());
    const pointer = `- [${name}](${fileName}) — ${description}`;
    const existingIdx = lines.findIndex((l) => l.includes(`(${fileName})`));
    if (existingIdx >= 0) {
        lines[existingIdx] = pointer;
    }
    else {
        lines.push(pointer);
    }
    writeFileSync(entrypoint, lines.join("\n") + "\n", "utf-8");
}
function removeFromIndex(worktree, fileName) {
    const entrypoint = getMemoryEntrypoint(worktree);
    const existing = readIndex(worktree);
    const lines = existing
        .split("\n")
        .filter((l) => l.trim() && !l.includes(`(${fileName})`));
    writeFileSync(entrypoint, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf-8");
}
/**
 * 扫描 worktree 下所有记忆文件（不含 MEMORY.md），为没有向量的文件生成并存入向量库
 * 用于存量数据回填，新增记忆由 saveMemory 自动处理
 */
export async function backfillMemoryVectors(worktree) {
    const memDir = getMemoryDir(worktree);
    const files = readdirSync(memDir, { encoding: "utf-8" })
        .filter(f => f.endsWith(".md") && f !== ENTRYPOINT_NAME);
    if (files.length === 0)
        return { total: 0, success: 0, failed: 0 };
    const { EmbeddingService } = await import("./embedding/service.js");
    const provider = new EmbeddingService();
    const db = await getDatabase();
    let success = 0;
    let failed = 0;
    for (const file of files) {
        try {
            const filePath = join(memDir, file);
            const rawContent = readFileSync(filePath, "utf-8");
            // 提取 frontmatter 后的正文内容（与 saveMemory / parseFrontmatter 逻辑一致）
            const trimmed = rawContent.trim();
            let content = trimmed;
            if (trimmed.startsWith("---")) {
                const endIdx = trimmed.indexOf("\n---", 3);
                if (endIdx !== -1) {
                    content = trimmed.slice(endIdx + 4).trim();
                }
            }
            if (!content) {
                failed++;
                continue;
            }
            const vector = await provider.getSingleEmbedding(content);
            db.upsertMemoryVector(file, worktree, vector, content);
            success++;
        }
        catch (e) {
            log.error(`[backfillMemoryVectors] 处理失败: ${file}`, e);
            failed++;
        }
    }
    return { total: files.length, success, failed };
}
function formatFileSize(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    return `${(bytes / 1024).toFixed(1)}KB`;
}
// Port of Claude Code's truncateEntrypointContent() from memdir.ts.
// Uses .length (char count, same as Claude Code) for byte measurement.
export function truncateEntrypoint(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return { content: "", lineCount: 0, byteCount: 0, wasLineTruncated: false, wasByteTruncated: false };
    const contentLines = trimmed.split("\n");
    const lineCount = contentLines.length;
    const byteCount = trimmed.length;
    const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
    const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;
    if (!wasLineTruncated && !wasByteTruncated) {
        return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated };
    }
    let truncated = wasLineTruncated
        ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join("\n")
        : trimmed;
    if (truncated.length > MAX_ENTRYPOINT_BYTES) {
        const cutAt = truncated.lastIndexOf("\n", MAX_ENTRYPOINT_BYTES);
        truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
    }
    const reason = wasByteTruncated && !wasLineTruncated
        ? `${formatFileSize(byteCount)} (limit: ${formatFileSize(MAX_ENTRYPOINT_BYTES)}) — index entries are too long`
        : wasLineTruncated && !wasByteTruncated
            ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
            : `${lineCount} lines and ${formatFileSize(byteCount)}`;
    return {
        content: truncated + `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
        lineCount,
        byteCount,
        wasLineTruncated,
        wasByteTruncated,
    };
}
