// Re-export workerSessionIDs from core for session tracking
import { workerSessionIDs } from "./worker.js";
import * as log from "./log.js";
/**
 * Create an LLMClient backed by the OpenCode SDK.
 *
 * Each call to `prompt()` creates a fresh hidden child session, sends the
 * prompt, extracts the text, and discards the session (rotation). This
 * prevents accumulating multiple assistant messages with reasoning/thinking
 * parts, which providers reject.
 *
 * @param client     The OpenCode SDK client
 * @param parentID   Parent session ID — child sessions are created under this
 */
export function createOpenCodeLLMClient(client, parentID) {
    return {
        async prompt(system, user, opts) {
            // Create a fresh worker session for this call
            let workerID;
            try {
                const session = await client.session.create({
                    body: { parentID, title: `lore ${opts?.workerID ?? "worker"}` },
                });
                if (!session.data) {
                    log.warn("failed to create worker session");
                    return null;
                }
                workerID = session.data.id;
                workerSessionIDs.add(workerID);
            }
            catch (e) {
                log.warn("failed to create worker session:", e);
                return null;
            }
            const parts = [
                { type: "text", text: `${system}\n\n${user}` },
            ];
            const agent = opts?.workerID;
            const model = opts?.model;
            // First attempt — with agent
            let result;
            try {
                result = await client.session.prompt({
                    path: { id: workerID },
                    body: {
                        parts,
                        ...(agent ? { agent } : {}),
                        ...(model ? { model } : {}),
                    },
                });
            }
            catch (e) {
                result = { error: e };
            }
            const text = extractText(result);
            if (text !== null)
                return text;
            // Check for agent-not-found -> retry without agent
            const errStr = stringifyError(result.error);
            if (/agent[^"]*not found/i.test(errStr)) {
                log.warn(`agent "${agent}" not found, retrying without agent`);
                // Create a fresh worker session for the retry
                let retryWorkerID;
                try {
                    const session = await client.session.create({
                        body: { parentID },
                    });
                    if (!session.data) {
                        log.warn("failed to create retry worker session");
                        return null;
                    }
                    retryWorkerID = session.data.id;
                    workerSessionIDs.add(retryWorkerID);
                }
                catch (e) {
                    log.warn("failed to create retry worker session:", e);
                    return null;
                }
                let retry;
                try {
                    retry = await client.session.prompt({
                        path: { id: retryWorkerID },
                        body: {
                            parts,
                            // No agent parameter — use session defaults
                            ...(model ? { model } : {}),
                        },
                    });
                }
                catch (e) {
                    retry = { error: e };
                }
                const retryText = extractText(retry);
                if (retryText !== null)
                    return retryText;
                log.warn("worker prompt retry also failed:", retry.error);
                return null;
            }
            log.warn("worker prompt failed:", result.error);
            return null;
        },
        async promptForSubAgent(system, user, opts) {
            // Create a fresh worker session for this call
            let subSessionId;
            const agentName = opts?.agentName ?? "auto-worker";
            const logPrefix = `[${agentName}]`;
            try {
                const session = await client.session.create({
                    body: { parentID, title: `testAgent ${agentName}` },
                });
                if (!session.data) {
                    log.warn(logPrefix + "failed to create worker session");
                    return null;
                }
                subSessionId = session.data.id;
                workerSessionIDs.add(subSessionId);
                log.info(logPrefix + `promptForSubAgent create session: ${subSessionId}`);
            }
            catch (e) {
                log.warn(logPrefix + "failed to create worker session:", e);
                return null;
            }
            const parts = [
                { type: "text", text: `${system}${user ? "\n\n" : ""}${user ?? ""}` },
            ];
            const agent = opts?.agentName;
            const model = opts?.model;
            // First attempt — with agent
            let result;
            try {
                log.info(logPrefix + `promptForSubAgent prompt start, session id: ${subSessionId}, model: ${JSON.stringify(model)}`);
                result = await client.session.prompt({
                    path: { id: subSessionId },
                    body: {
                        parts,
                        ...(agent ? { agent } : {}),
                        ...(model ? { model } : {}),
                    },
                });
            }
            catch (e) {
                result = { error: e };
            }
            const text = extractText(result);
            if (text !== null) {
                log.info(logPrefix + `promptForSubAgent prompt finish, session id: ${subSessionId}`);
                return text;
            }
            log.warn(logPrefix + `promptForSubAgent prompt failed, session id: ${subSessionId}, error: `, result.error);
            log.warn(logPrefix + `promptForSubAgent prompt failed, session id: ${subSessionId}, result: ${JSON.stringify(result)}`);
            return null;
        },
    };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Extract the first text part from a session.prompt() result. */
function extractText(result) {
    if (!result.data || typeof result.data !== "object")
        return null;
    const data = result.data;
    if (!data.parts || !Array.isArray(data.parts))
        return null;
    const textPart = data.parts.find((p) => p.type === "text" && typeof p.text === "string");
    return textPart?.text ?? null;
}
/** Safely stringify an error for regex matching. */
function stringifyError(error) {
    if (!error)
        return "";
    if (typeof error === "string")
        return error;
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
