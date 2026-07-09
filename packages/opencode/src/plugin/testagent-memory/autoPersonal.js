import { readLastConsolidatedAt, tryAcquireConsolidationLock, rollbackConsolidationLock, LOCK_FILE_PERSONAL, } from "./core/consolidationLock.js";
import * as log from "./core/log.js";
import { AUTO_PERSONAL_PROMPT } from "./prompt.js";
import { config } from "./core/config.js";
// Scan throttle: when time-gate passes but session-gate doesn't, the lock
// mtime doesn't advance, so the time-gate keeps passing every turn.
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000;
let lastPersonalScanAt = 0;
export async function runAutoPersonal(input) {
    const { llm, projectPath, model, force } = input;
    // --- Time gate ---
    let lastAt;
    try {
        lastAt = await readLastConsolidatedAt(projectPath, LOCK_FILE_PERSONAL);
        log.info(`[autoPersonal] last at: ${lastAt}`);
    }
    catch (e) {
        log.error(`[autoPersonal] readLastConsolidatedAt failed: ${e.message}`);
        return;
    }
    const hoursSince = (Date.now() - lastAt) / 3_600_000;
    if (!force && hoursSince < 24) {
        log.warn(`[autoPersonal] only since ${Math.floor(hoursSince)} hours, need 24 hours`);
        return;
    }
    log.info(`[autoPersonal] since hours: ${hoursSince}`);
    // --- Scan throttle ---
    const sinceScanMs = Date.now() - lastPersonalScanAt;
    if (!force && sinceScanMs < SESSION_SCAN_INTERVAL_MS) {
        log.warn(`[autoPersonal] scan throttle — time-gate passed but last scan was ${Math.round(sinceScanMs / 1000)}s ago`);
        return;
    }
    lastPersonalScanAt = Date.now();
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
            priorMtime = await tryAcquireConsolidationLock(projectPath, LOCK_FILE_PERSONAL);
        }
        catch (e) {
            log.error(`[autoPersonal] lock acquire failed: ${e.message}`);
            return;
        }
        if (priorMtime === null)
            return;
    }
    log.info(`[autoPersonal] priorMtime is: ${lastAt}`);
    log.info(`[autoPersonal] firing — ${hoursSince.toFixed(1)}h since last.`);
    try {
        const prompt = config().memory.personalMemoryPrompt?.trim() || AUTO_PERSONAL_PROMPT;
        const responseText = await llm.promptForSubAgent(prompt, "", {
            model,
            agentName: "auto-personal-memory",
        });
        if (responseText != null && responseText.length > 0) {
            log.info(`[autoPersonal] completed success`);
        }
        else {
            log.warn(`[autoPersonal] completed fail, response text is empty`);
        }
    }
    catch (e) {
        log.error(`[autoPersonal] fork failed: ${e.message}`);
        await rollbackConsolidationLock(projectPath, priorMtime, LOCK_FILE_PERSONAL);
    }
}
