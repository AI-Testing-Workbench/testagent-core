import * as log from "./core/log.js";
import { workerSessionIDs } from "./core/worker.js";
let isPrompting = false;
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
export function createOpenCodeRecallLLMClient(client, parentID, opts) {
    return {
        async prompt(system, user, opts) {
            // 1. 防重复执行锁
            if (isPrompting)
                return null;
            isPrompting = true;
            let workerID;
            let childSession = null;
            // First attempt — with agent
            let llmResult = {};
            try {
                // ==================== 2：创建子会话 ====================
                childSession = await client.session.create({
                    body: { parentID, title: `opencode-memory ${opts?.workerID ?? "worker"}` },
                });
                if (!childSession.data) {
                    return null;
                }
                workerID = childSession.data.id;
                workerSessionIDs.add(workerID);
                // ==================== 3：关键！只调用 一次 prompt ====================
                if (opts?.model?.providerID) {
                    try {
                        llmResult = await client.session.prompt({
                            path: { id: workerID },
                            body: {
                                //system: system, // 关键：把提示词放这里
                                parts: [
                                    { type: "text", text: `${system}` },
                                ],
                                // 可选配置
                                model: opts?.model,
                                agent: "memory-recall",
                                // model: { providerID: "opencode", modelID: "gpt-5-nano" }, // 免费轻量
                            },
                        });
                    }
                    catch (e) {
                        log.error("[llmRecall retry] error:", e);
                        // 2. 失败重试：第二次调用 — 无 agent
                        await client.session.delete({ path: { id: childSession.data.id } });
                        workerSessionIDs.delete(childSession.data.id);
                        childSession = await client.session.create({
                            body: { parentID, title: `opencode-memory ${opts?.workerID ?? "worker"}` },
                        });
                        if (!childSession.data) {
                            return null;
                        }
                        workerID = childSession.data.id;
                        workerSessionIDs.add(workerID);
                        llmResult = await client.session.prompt({
                            path: { id: workerID },
                            body: {
                                //system: system, // 关键：把提示词放这里
                                parts: [
                                    { type: "text", text: `${system}` },
                                ],
                            },
                        });
                    }
                }
                else {
                    llmResult = await client.session.prompt({
                        path: { id: workerID },
                        body: {
                            //system: system, // 关键：把提示词放这里
                            parts: [
                                { type: "text", text: `${system}` },
                            ],
                        },
                    });
                }
                const retryText = extractText(llmResult);
                if (retryText !== null) {
                    return retryText;
                }
            }
            catch (e) {
                log.error("[llmRecall final] error:", e);
            }
            finally {
                // ==================== 4：无论如何都释放锁 ====================
                isPrompting = false;
                // ==================== 5：可选：主动关闭/销毁子会话（彻底杜绝循环） ====================
                if (childSession && childSession.data && childSession.data.id) {
                    try {
                        await client.session.delete({ path: { id: childSession.data.id } });
                        workerSessionIDs.delete(childSession.data.id);
                    }
                    catch {
                        await client.session.delete({ path: { id: childSession.data.id } });
                        workerSessionIDs.delete(childSession.data.id);
                    }
                }
            }
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
