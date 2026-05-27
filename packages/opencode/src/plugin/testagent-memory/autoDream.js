import { readLastConsolidatedAt, tryAcquireConsolidationLock, rollbackConsolidationLock, LOCK_FILE_DREAM, } from "./core/consolidationLock.js";
import * as log from "./core/log.js";
import { AUTO_TREAM_PROMPT } from "./prompt.js";
// Scan throttle: when time-gate passes but session-gate doesn't, the lock
// mtime doesn't advance, so the time-gate keeps passing every turn.
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULTS = {
    minHours: 24,
    minSessions: 5,
};
/**
 * Thresholds from tengu_onyx_plover. The enabled gate lives in config.ts
 * (isAutoDreamEnabled); this returns only the scheduling knobs. Defensive
 * per-field validation since GB cache can return stale wrong-type values.
 */
function getConfig() {
    // 后续增加可配置
    const raw = { minHours: 24, minSessions: 5 };
    return {
        minHours: typeof raw?.minHours === "number" &&
            Number.isFinite(raw.minHours) &&
            raw.minHours > 0
            ? raw.minHours
            : DEFAULTS.minHours,
        minSessions: typeof raw?.minSessions === "number" &&
            Number.isFinite(raw.minSessions) &&
            raw.minSessions > 0
            ? raw.minSessions
            : DEFAULTS.minSessions,
    };
}
let lastSessionScanAt = 0;
export async function runAutoDream(input) {
    const { llm, projectPath, model, force } = input;
    const cfg = getConfig();
    // --- Time gate ---
    let lastAt;
    try {
        lastAt = await readLastConsolidatedAt(projectPath, LOCK_FILE_DREAM);
        log.info(`[autoDream] last at: ${lastAt}`);
    }
    catch (e) {
        log.error(`[autoDream] readLastConsolidatedAt failed: ${e.message}`);
        return;
    }
    const hoursSince = (Date.now() - lastAt) / 3_600_000;
    if (!force && hoursSince < cfg.minHours) {
        log.warn(`[autoDream] only since ${Math.floor(hoursSince)} hours, need ${cfg.minHours} hours`);
        return;
    }
    log.info(`[autoDream] since hours: ${hoursSince}`);
    log.info(`[autoDream] last session scan at: ${lastAt}`);
    // --- Scan throttle ---
    const sinceScanMs = Date.now() - lastSessionScanAt;
    if (!force && sinceScanMs < SESSION_SCAN_INTERVAL_MS) {
        log.warn(`[autoDream] scan throttle — time-gate passed but last scan was ${Math.round(sinceScanMs / 1000)}s ago`);
        return;
    }
    lastSessionScanAt = Date.now();
    // --- Lock ---
    // Under force, skip acquire entirely — use the existing mtime so
    // kill's rollback is a no-op (rewinds to where it already is).
    // The lock file stays untouched; next non-force turn sees it as-is.
    let priorMtime;
    if (force) {
        priorMtime = lastAt;
    }
    else {
        try {
            priorMtime = await tryAcquireConsolidationLock(projectPath, LOCK_FILE_DREAM);
        }
        catch (e) {
            log.error(`[autoDream] lock acquire failed: ${e.message}`);
            return;
        }
        if (priorMtime === null)
            return;
    }
    log.info(`[autoDream] priorMtime is: ${lastAt}`);
    log.info(`[autoDream] firing — ${hoursSince.toFixed(1)}h since last.`);
    try {
        const responseText = await llm.promptForSubAgent(AUTO_TREAM_PROMPT, "", {
            model,
            agentName: "auto-dream",
        });
        if (responseText != null && responseText.length > 0) {
            log.info(`[autoDream] completed success`);
        }
        else {
            log.warn(`[autoDream] completed fail, response text is empty`);
        }
    }
    catch (e) {
        log.error(`[autoDream] fork failed: ${e.message}`);
        await rollbackConsolidationLock(projectPath, priorMtime, LOCK_FILE_DREAM);
    }
}
