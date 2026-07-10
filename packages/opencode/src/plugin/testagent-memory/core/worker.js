// ---------------------------------------------------------------------------
// Shared worker session tracking
// ---------------------------------------------------------------------------
/** Set of ALL worker session IDs across distillation, curator, and query expansion.
 *  Used by shouldSkip() in index.ts to avoid storing/distilling worker messages. */
export const workerSessionIDs = new Set();
export function isWorkerSession(sessionID) {
    return workerSessionIDs.has(sessionID);
}
export function inferRoleFromPart(part) {
    const text = (typeof part.text === "string" ? part.text : "").toLowerCase();
    if (text.startsWith("user:") || text.startsWith("human:"))
        return "user";
    if (text.startsWith("assistant:") || text.startsWith("ai:"))
        return "assistant";
    return "unknown";
}
