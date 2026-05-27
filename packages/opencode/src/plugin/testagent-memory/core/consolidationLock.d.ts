export declare const LOCK_FILE_DREAM = ".consolidate-lock";
export declare const LOCK_FILE_PERSONAL = ".personal-lock";
/**
 * mtime of the lock file = lastConsolidatedAt. 0 if absent.
 * Per-turn cost: one stat.
 */
export declare function readLastConsolidatedAt(worktree: string, lockName: string): Promise<number>;
/**
 * Acquire: write PID → mtime = now. Returns the pre-acquire mtime
 * (for rollback), or null if blocked / lost a race.
 *
 *   Success → do nothing. mtime stays at now.
 *   Failure → rollbackConsolidationLock(priorMtime) rewinds mtime.
 *   Crash   → mtime stuck, dead PID → next process reclaims.
 */
export declare function tryAcquireConsolidationLock(worktree: string, lockName: string): Promise<number | null>;
/**
 * Check if a process with the given PID is running (signal 0 probe).
 *
 * PID ≤ 1 returns false (0 is current process group, 1 is init).
 *
 * Note: `process.kill(pid, 0)` throws EPERM when the process exists but is
 * owned by another user. This reports such processes as NOT running, which
 * is conservative for lock recovery (we won't steal a live lock).
 */
export declare function isProcessRunning(pid: number): boolean;
/**
 * Rewind mtime to pre-acquire after a failed fork. Clears the PID body —
 * otherwise our still-running process would look like it's holding.
 * priorMtime 0 → unlink (restore no-file).
 */
export declare function rollbackConsolidationLock(worktree: string, priorMtime: number, lockName: string): Promise<void>;
/**
 * Stamp from manual /dream. Optimistic — fires at prompt-build time,
 * no post-skill completion hook. Best-effort.
 */
export declare function recordConsolidation(worktree: string, lockName: string): Promise<void>;
