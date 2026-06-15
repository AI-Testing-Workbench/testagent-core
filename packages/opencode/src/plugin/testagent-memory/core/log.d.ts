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
/** Log an informational status message. Suppressed unless LORE_DEBUG=1. */
export declare function info(...args: unknown[]): void;
/** Log a warning. Suppressed unless LORE_DEBUG=1. */
export declare function warn(...args: unknown[]): void;
/** Log an error. Always visible — these indicate real failures. */
export declare function error(...args: unknown[]): void;
export declare function debug(...args: unknown[]): void;
