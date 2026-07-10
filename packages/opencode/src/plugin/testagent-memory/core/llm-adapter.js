// Re-export workerSessionIDs from core for session tracking
import { workerSessionIDs } from "./worker.js";
import * as log from "./log.js";
import { sendTraceLog } from "./trace-log.js";
import { config } from "./config.js";
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
            const agent = opts?.agentName;
            const model = opts?.model;
            const messageId = opts?.messageId ?? "";
            const partId = opts?.partId ?? "";
            const eventSource = opts?.eventSource ?? "";
            // 如果是input_content字符串,则默认字符串，否则json化
            let input_content;
            if (typeof opts?.traceInput === "string") {
                input_content = opts?.traceInput;
            }
            else {
                input_content = opts?.traceInput !== undefined ? JSON.stringify(opts.traceInput) : '';
            }
            const traceData = {
                user_query: "",
                provider_id: model?.providerID ?? "",
                model_id: model?.modelID ?? "",
                session_id: "",
                p_session_id: parentID,
                agent_name: agentName,
                op_type: agentName,
                op_flag: "F",
                event_source: eventSource,
                start_time: new Date(),
                end_time: new Date(),
                config_param: JSON.stringify(config()),
                input_content: input_content,
                output_content: "",
                other_content: "",
                prompt: "",
                message_id: messageId,
                part_id: partId,
            };
            const traceRsp = {
                success: false,
                message: "",
                data: "",
            };
            try {
                const session = await client.session.create({
                    body: { parentID, title: `testAgent ${agentName}` },
                });
                if (!session.data) {
                    const errorMsg = logPrefix + "failed to create worker session";
                    log.warn(errorMsg);
                    // 埋点日志
                    traceRsp.message = errorMsg;
                    traceData.output_content = JSON.stringify(traceRsp);
                    traceData.end_time = new Date();
                    sendTraceLog(traceData);
                    return null;
                }
                subSessionId = session.data.id;
                workerSessionIDs.add(subSessionId);
                log.info(logPrefix + `promptForSubAgent create session: ${subSessionId}`);
                // 埋点日志
                traceData.session_id = subSessionId;
            }
            catch (e) {
                const errorMsg = logPrefix + "failed to create worker session";
                log.warn(`${errorMsg}, parent session id: ${parentID} : `, e);
                // 埋点日志
                traceRsp.message = errorMsg;
                traceData.output_content = JSON.stringify(traceRsp);
                traceData.end_time = new Date();
                sendTraceLog(traceData);
                return null;
            }
            const llmPrompt = `${system}${user ? "\n\n" : ""}${user ?? ""}`;
            traceData.prompt = llmPrompt;
            const parts = [
                { type: "text", text: llmPrompt },
            ];
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
                const partInfo = extractPartInfo(result);
                // 埋点日志
                traceData.message_id = partInfo.msgId;
                traceData.part_id = partInfo.partId;
            }
            catch (e) {
                result = { error: e };
            }
            const text = extractText(result);
            if (text !== null) {
                log.info(logPrefix + `promptForSubAgent prompt finish, session id: ${subSessionId}`);
                // 埋点日志
                traceRsp.success = true;
                traceRsp.data = text;
                traceData.output_content = JSON.stringify(traceRsp);
                traceData.op_flag = "S";
                traceData.end_time = new Date();
                sendTraceLog(traceData);
                return text;
            }
            const errorText = `${logPrefix}promptForSubAgent prompt failed, session id: ${subSessionId}`;
            log.warn(`${errorText}, error: `, result.error);
            log.warn(`${errorText}, result: ${JSON.stringify(result)}`);
            // 埋点响应数据格式
            traceRsp.data = result;
            traceRsp.message = errorText;
            // 埋点日志
            traceData.output_content = JSON.stringify(traceRsp);
            traceData.end_time = new Date();
            sendTraceLog(traceData);
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
function extractPartInfo(result) {
    if (!result.data || typeof result.data !== "object")
        return { msgId: "", partId: "" };
    const data = result.data;
    if (!data.parts || !Array.isArray(data.parts))
        return { msgId: "", partId: "" };
    const textPart = data.parts.find((p) => p.type === "text" && typeof p.text === "string");
    return { msgId: textPart?.messageID ?? "", partId: textPart?.id ?? "" };
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
