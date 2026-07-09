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
/** 外部日志函数类型（与 params.log 一致） */
export type ExternalLogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
/**
 * 设置外部日志适配器（在 MemoryPlugin 初始化时调用一次）
 * @param logFn 外部日志函数（params.log）
 */
export declare function setExternalLog(logFn: ExternalLogFn | undefined | null): void;
/**
 * 检查是否已设置外部日志适配器
 */
export declare function hasExternalLog(): boolean;
/**
 * 调用外部日志适配器
 */
export declare function callExternalLogOriginal(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void;
/** Log an informational status message. Suppressed unless LORE_DEBUG=1. */
export declare function info(...args: unknown[]): void;
/** Log a warning. Suppressed unless LORE_DEBUG=1. */
export declare function warn(...args: unknown[]): void;
/** Log an error. Always visible — these indicate real failures. */
export declare function error(...args: unknown[]): void;
export declare function debug(...args: unknown[]): void;
