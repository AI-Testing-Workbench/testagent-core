/**
 * Lightweight logger that suppresses informational messages by default.
 *
 * In TUI mode, all stderr output renders as red "error" text — confusing
 * for routine status messages like "incremental distillation" or "pruned
 * temporal messages". Only actual errors should be visible by default.
 *
 * Set LORE_DEBUG=1 to see informational messages (useful when debugging
 * the plugin itself).
 *
 * 提供统一的日志接口，支持外部日志适配器（如 params.log）和内部日志（./log.js）
 * 在 MemoryPlugin 初始化时设置外部日志适配器，之后所有模块可直接使用
 */
import { log } from './mem-logger.js';
import { config } from './config.js';
const isDebug = !!process.env.LORE_DEBUG;
/** 全局外部日志适配器单例 */
let externalLog = null;
const DEFAULT_SERVICE_DATA = { service: "offical-memory" };
/**
 * 设置外部日志适配器（在 MemoryPlugin 初始化时调用一次）
 * @param logFn 外部日志函数（params.log）
 */
export function setExternalLog(logFn) {
    externalLog = logFn || null;
}
/**
 * 检查是否已设置外部日志适配器
 */
export function hasExternalLog() {
    return externalLog !== null;
}
/**
 * 调用外部日志适配器
 */
export function callExternalLogOriginal(level, message, data) {
    if (externalLog) {
        externalLog(level, message, { ...DEFAULT_SERVICE_DATA, ...data });
    }
}
/**
 * 调用外部日志适配器
 */
function callExternalLog(level, ...args) {
    if (externalLog) {
        const { message, data } = extractDataFromArgs(args);
        externalLog(level, message, { ...DEFAULT_SERVICE_DATA, ...data });
    }
}
/** Log an informational status message. Suppressed unless LORE_DEBUG=1. */
export function info(...args) {
    // 优先调用外部日志适配器
    callExternalLog("info", args);
    log("[info]" + logText(args));
}
/** Log a warning. Suppressed unless LORE_DEBUG=1. */
export function warn(...args) {
    // 优先调用外部日志适配器
    callExternalLog("warn", args);
    log("[warn]" + logText(args));
}
/** Log an error. Always visible — these indicate real failures. */
export function error(...args) {
    // 优先调用外部日志适配器
    callExternalLog("error", args);
    log("[error]" + logText(args));
}
export function debug(...args) {
    if (config().debug) {
        // 优先调用外部日志适配器
        callExternalLog("debug", args);
        log("[debug]" + logText(args));
    }
}
/**
 * 从参数中提取最后的对象作为 data，其余作为 message
 * 返回 { message: string, data: Record<string, unknown> }
 */
function extractDataFromArgs(args) {
    if (args.length === 0)
        return { message: "", data: {} };
    const lastArg = args[args.length - 1];
    if (lastArg && typeof lastArg === 'object' && !Array.isArray(lastArg)) {
        // 最后一个参数是对象，作为 data，其余作为 message
        const data = lastArg;
        const messageArgs = args.slice(0, -1);
        const message = messageArgs.length > 0 ? logText(...messageArgs) : "";
        return { message, data };
    }
    // 否则将所有参数作为 message
    return { message: logText(...args), data: {} };
}
function logText(...args) {
    if (args === null || args === undefined) {
        return "";
    }
    // 每个参数强制转字符串，空格分隔
    const text = args.map(item => String(item)).join('\n');
    return text;
}
