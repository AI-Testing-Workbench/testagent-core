import * as log from "./core/log.js";
import { workerSessionIDs } from "./core/worker.js";
import { AUTO_EXTRACTION_PROMPT } from "./prompt.js";
import { config } from "./core/config.js";
// Re-export for backwards compat — index.ts and others may still import from here.
export { workerSessionIDs };
// Worker sessions keyed by parent session ID — hidden children, one per source session
const workerSessions = new Map();
// Main distillation entry point — called on session.idle or when urgent
export async function run(input) {
    let rounds = 0;
    let distilled = 0;
    log.info(`[autoExtraction] start now, parent session id: ${input.sessionID}`);
    const model = input.model ?? undefined;
    const messages = input.buffer.drain();
    distilled = messages.length;
    const messageText = messages
        .map((m) => `[${m.role}]: ${m.content}`)
        .join("\n\n")
        .slice(0, config().memory.autoExtractMaxLength);
    const userContent = `## Recent conversation messages (last ~${messages.length})\n\n${messageText}\n\nExtract memories from the messages above.`;
    //log.error(`run, userContent=${userContent}`);
    const responseText = await input.llm.promptForSubAgent(AUTO_EXTRACTION_PROMPT, userContent, { model, agentName: "auto-extraction" });
    // 如果提取失败重新 追加会缓存
    if (responseText === null && messages.length > 0) {
        log.warn(`[autoExtraction] finish now, but fail, repush cache now, parent session id: ${input.sessionID}`);
        messages.forEach(item => {
            input.buffer.push(item);
        });
    }
    return { rounds, distilled };
}
