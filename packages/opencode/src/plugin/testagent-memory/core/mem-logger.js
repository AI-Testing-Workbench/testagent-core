import { appendFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, unlinkSync, } from "fs";
import { homedir } from "os";
import { join } from "path";
function getLogFilePath() {
    return process.env.OPENCODE_MEM_LOG_FILE || join(homedir(), ".testagent-memory", "testagent-mem.log");
}
function getLogDirPath() {
    const logFile = getLogFilePath();
    const lastSlash = Math.max(logFile.lastIndexOf("/"), logFile.lastIndexOf("\\"));
    return lastSlash === -1 ? "." : logFile.slice(0, lastSlash);
}
const MAX_LOG_SIZE = 5 * 1024 * 1024;
const GLOBAL_LOGGER_KEY = Symbol.for("testagent-memory.logger.initialized");
function rotateLog() {
    const logFile = getLogFilePath();
    try {
        if (!existsSync(logFile))
            return;
        const stats = statSync(logFile);
        if (stats.size < MAX_LOG_SIZE)
            return;
        const oldLog = logFile + ".old";
        if (existsSync(oldLog))
            unlinkSync(oldLog);
        renameSync(logFile, oldLog);
    }
    catch { }
}
function ensureLoggerInitialized() {
    if (globalThis[GLOBAL_LOGGER_KEY])
        return;
    const logDir = getLogDirPath();
    const logFile = getLogFilePath();
    if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
    }
    rotateLog();
    writeFileSync(logFile, `\n--- Session started: ${new Date(Date.now() + 8 * 3600000).toISOString()} ---\n`, {
        flag: "a",
    });
    globalThis[GLOBAL_LOGGER_KEY] = true;
}
export function log(message, data) {
    ensureLoggerInitialized();
    const logFile = getLogFilePath();
    //const timestamp = new Date().toISOString();
    const timestamp = new Date(Date.now() + 8 * 3600000).toISOString();
    const isEmptyObject = (obj) => {
        return obj !== null && typeof obj === 'object' && Object.keys(obj).length === 0;
    };
    const line = data && !isEmptyObject(data)
        ? `[${timestamp}] ${message}: ${JSON.stringify(data)}\n`
        : `[${timestamp}] ${message}\n`;
    appendFileSync(logFile, line);
}
