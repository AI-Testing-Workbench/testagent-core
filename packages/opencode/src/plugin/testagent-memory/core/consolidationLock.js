import { mkdir, readFile, stat, unlink, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import { getMemoryDir } from "../paths.js";
import * as log from "./log.js";
export const LOCK_FILE_DREAM = '.consolidate-lock';
export const LOCK_FILE_PERSONAL = '.personal-lock';
// Stale past this even if the PID is live (PID reuse guard).
const HOLDER_STALE_MS = 60 * 60 * 1000;
// 获取锁文件路径
function lockPath(worktree, lockName) {
    return join(getMemoryDir(worktree), lockName);
}
/**
 * mtime of the lock file = lastConsolidatedAt. 0 if absent.
 * Per-turn cost: one stat.
 */
export async function readLastConsolidatedAt(worktree, lockName) {
    try {
        const s = await stat(lockPath(worktree, lockName));
        return s.mtimeMs;
    }
    catch {
        return 0;
    }
}
/**
 * Acquire: write PID → mtime = now. Returns the pre-acquire mtime
 * (for rollback), or null if blocked / lost a race.
 *
 *   Success → do nothing. mtime stays at now.
 *   Failure → rollbackConsolidationLock(priorMtime) rewinds mtime.
 *   Crash   → mtime stuck, dead PID → next process reclaims.
 */
export async function tryAcquireConsolidationLock(worktree, lockName) {
    const path = lockPath(worktree, lockName);
    let mtimeMs;
    let holderPid;
    try {
        const [s, raw] = await Promise.all([stat(path), readFile(path, 'utf8')]);
        mtimeMs = s.mtimeMs;
        const parsed = parseInt(raw.trim(), 10);
        holderPid = Number.isFinite(parsed) ? parsed : undefined;
    }
    catch {
        // ENOENT — no prior lock.
    }
    if (mtimeMs !== undefined && Date.now() - mtimeMs < HOLDER_STALE_MS) {
        if (holderPid !== undefined && isProcessRunning(holderPid)) {
            log.warn(`[lock] lock held by live PID ${holderPid} (mtime ${Math.round((Date.now() - mtimeMs) / 1000)}s ago)`);
            return null;
        }
        // Dead PID or unparseable body — reclaim.
    }
    // Memory dir may not exist yet.
    await mkdir(getMemoryDir(worktree), { recursive: true });
    await writeFile(path, String(process.pid));
    // Two reclaimers both write → last wins the PID. Loser bails on re-read.
    let verify;
    try {
        verify = await readFile(path, 'utf8');
    }
    catch {
        return null;
    }
    if (parseInt(verify.trim(), 10) !== process.pid)
        return null;
    return mtimeMs ?? 0;
}
/**
 * Check if a process with the given PID is running (signal 0 probe).
 *
 * PID ≤ 1 returns false (0 is current process group, 1 is init).
 *
 * Note: `process.kill(pid, 0)` throws EPERM when the process exists but is
 * owned by another user. This reports such processes as NOT running, which
 * is conservative for lock recovery (we won't steal a live lock).
 */
export function isProcessRunning(pid) {
    if (pid <= 1)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Rewind mtime to pre-acquire after a failed fork. Clears the PID body —
 * otherwise our still-running process would look like it's holding.
 * priorMtime 0 → unlink (restore no-file).
 */
export async function rollbackConsolidationLock(worktree, priorMtime, lockName) {
    const path = lockPath(worktree, lockName);
    try {
        if (priorMtime === 0) {
            await unlink(path);
            return;
        }
        await writeFile(path, '');
        const t = priorMtime / 1000; // utimes wants seconds
        await utimes(path, t, t);
    }
    catch (e) {
        log.error(`[lock] rollback failed: ${e.message} — next trigger delayed to minHours`);
    }
}
/**
 * Stamp from manual /dream. Optimistic — fires at prompt-build time,
 * no post-skill completion hook. Best-effort.
 */
export async function recordConsolidation(worktree, lockName) {
    try {
        // Memory dir may not exist yet (manual /dream before any auto-trigger).
        await mkdir(getMemoryDir(worktree), { recursive: true });
        await writeFile(lockPath(worktree, lockName), String(process.pid));
    }
    catch (e) {
        log.error(`[lock] recordConsolidation write failed: ${e.message}`);
    }
}
