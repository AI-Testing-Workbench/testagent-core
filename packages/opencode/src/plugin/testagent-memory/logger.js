import fs from "node:fs";
import path from "node:path";
const DEFAULT_LOG_DIR = ".opencode-memory-logs";
function getDateString() {
    return new Date().toISOString().slice(0, 10);
}
function ensureLogDir(baseDir, customDir) {
    const logDir = customDir ? path.join(baseDir, customDir) : path.join(baseDir, DEFAULT_LOG_DIR);
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    return logDir;
}
function getLogFilePath(baseDir, customDir, sessionId) {
    const logDir = ensureLogDir(baseDir, customDir);
    const dateStr = getDateString();
    const fileName = sessionId ? `${dateStr}-${sessionId}.md` : `${dateStr}.md`;
    return path.join(logDir, fileName);
}
function formatLogEntry(entry) {
    return `---
timestamp: ${entry.timestamp}
sessionId: ${entry.sessionId}
---

${entry.content}

---
`;
}
export function appendLog(baseDir, sessionId, content, options) {
    const logPath = getLogFilePath(baseDir, options?.logDir, sessionId);
    const entry = {
        timestamp: new Date().toISOString(),
        sessionId,
        content,
    };
    const logContent = formatLogEntry(entry);
    if (!fs.existsSync(logPath)) {
        fs.writeFileSync(logPath, `# Session Logs - ${getDateString()}\n\n`);
    }
    fs.appendFileSync(logPath, logContent);
    return logPath;
}
export function listLogFiles(baseDir, customDir) {
    const logDir = ensureLogDir(baseDir, customDir);
    if (!fs.existsSync(logDir)) {
        return [];
    }
    return fs.readdirSync(logDir).filter((f) => f.endsWith(".md") || f.endsWith(".log"));
}
export function readLogFile(baseDir, fileName, customDir) {
    const logDir = ensureLogDir(baseDir, customDir);
    const filePath = path.join(logDir, fileName);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    return fs.readFileSync(filePath, "utf-8");
}
