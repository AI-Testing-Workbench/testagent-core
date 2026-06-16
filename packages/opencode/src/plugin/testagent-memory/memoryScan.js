import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { basename, join } from "path";
import { getMemoryDir, ENTRYPOINT_NAME, MAX_MEMORY_FILES, FRONTMATTER_MAX_LINES, } from "./paths.js";
const MEMORY_TYPES = ["user", "feedback", "project", "reference"];
function parseMemoryType(raw) {
    if (!raw)
        return undefined;
    return MEMORY_TYPES.includes(raw) ? raw : undefined;
}
function readFileHeader(filePath, maxLines) {
    try {
        const raw = readFileSync(filePath, "utf-8");
        const stat = statSync(filePath);
        const lines = raw.split("\n");
        const header = lines.slice(0, maxLines).join("\n");
        return { content: header, mtimeMs: stat.mtimeMs };
    }
    catch {
        return { content: "", mtimeMs: 0 };
    }
}
function parseFrontmatterHeader(raw) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("---")) {
        return {};
    }
    const lines = trimmed.split("\n");
    let closingLineIdx = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trimEnd() === "---") {
            closingLineIdx = i;
            break;
        }
    }
    if (closingLineIdx === -1) {
        return {};
    }
    const frontmatter = {};
    for (let i = 1; i < closingLineIdx; i++) {
        const line = lines[i];
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1)
            continue;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (key && value) {
            frontmatter[key] = value;
        }
    }
    return frontmatter;
}
/**
 * Recursive scan of memory directory. Reads only frontmatter (first N lines),
 * returns headers sorted by mtime desc, capped at MAX_MEMORY_FILES.
 * Port of Claude Code's scanMemoryFiles().
 */
export function scanMemoryFiles(memoryDir) {
    try {
        // 1. 路径不存在直接返回空
        if (!existsSync(memoryDir)) {
            return [];
        }
        const stat = statSync(memoryDir);
        let files = [];
        // --- 兼容逻辑开始 ---
        if (stat.isFile()) {
            // 情况1：传入的是【单个文件】
            files = [memoryDir];
        }
        else if (stat.isDirectory()) {
            // 情况2：传入的是【目录】（原有逻辑）
            const entries = readdirSync(memoryDir, { recursive: true, encoding: "utf-8" });
            files = entries
                .filter(f => f.endsWith(".md") && basename(f) !== ENTRYPOINT_NAME)
                .map(relativePath => join(memoryDir, relativePath));
        }
        // --- 兼容逻辑结束 ---
        const headers = [];
        // 统一遍历处理文件
        for (const filePath of files) {
            try {
                // 如果是目录传进来的，filename 存相对路径；如果是文件，存文件名
                const filename = stat.isDirectory()
                    ? filePath.replace(memoryDir, "").replace(/^[\\/]/, "")
                    : basename(filePath);
                const { content, mtimeMs } = readFileHeader(filePath, FRONTMATTER_MAX_LINES);
                const frontmatter = parseFrontmatterHeader(content);
                headers.push({
                    filename,
                    filePath,
                    mtimeMs,
                    name: frontmatter.name || null,
                    description: frontmatter.description || null,
                    type: parseMemoryType(frontmatter.type),
                });
            }
            catch {
                // skip unreadable files
            }
        }
        return headers
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(0, MAX_MEMORY_FILES);
    }
    catch {
        return [];
    }
}
// Port of Claude Code's formatMemoryManifest():
// `- [type] filename (ISO timestamp): description` per line
export function formatMemoryManifest(memories) {
    return memories
        .map((m) => {
        const tag = m.type ? `[${m.type}] ` : "";
        const ts = new Date(m.mtimeMs).toISOString();
        return m.description
            ? `- ${tag}${m.filename} (${ts}): ${m.description}`
            : `- ${tag}${m.filename} (${ts})`;
    })
        .join("\n");
}
export function getMemoryManifest(worktree) {
    const memoryDir = getMemoryDir(worktree);
    const headers = scanMemoryFiles(memoryDir);
    const manifest = formatMemoryManifest(headers);
    return { headers, manifest };
}
