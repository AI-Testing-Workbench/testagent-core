/**
 * Lightweight logger that suppresses informational messages by default.
 *
 * In TUI mode, all stderr output renders as red "error" text — confusing
 * for routine status messages like "incremental distillation" or "pruned
 * temporal messages". Only actual errors should be visible by default.
 *
 * Set LORE_DEBUG=1 to see informational messages (useful when debugging
 * the plugin itself).
 */
import { log } from './mem-logger.js';
import { config } from './config.js';
const isDebug = !!process.env.LORE_DEBUG;
/** Log an informational status message. Suppressed unless LORE_DEBUG=1. */
export function info(...args) {
    //console.error("[info]", ...args);
    log("[info]" + logText(args));
}
/** Log a warning. Suppressed unless LORE_DEBUG=1. */
export function warn(...args) {
    //console.error("[warn]", ...args);
    log("[warn]" + logText(args));
}
/** Log an error. Always visible — these indicate real failures. */
export function error(...args) {
    //console.error("[error]", ...args);
    log("[error]" + logText(args));
}
export function debug(...args) {
    if (config().debug) {
        log("[debug]" + logText(args));
    }
}
function logText(...args) {
    if (args === null || args === undefined) {
        return "";
    }
    // 每个参数强制转字符串，空格分隔
    const text = args.map(item => String(item)).join('\n');
    return text;
}
