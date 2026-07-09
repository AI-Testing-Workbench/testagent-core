import * as log from "./core/log.js";
import { workerSessionIDs } from "./core/worker.js";
import { AUTO_EXTRACTION_PROMPT } from "./prompt.js";
import { config } from "./core/config.js";
import { getDatabase } from "./core/db.js";
// Re-export for backwards compat — index.ts and others may still import from here.
export { workerSessionIDs };
// Worker sessions keyed by parent session ID — hidden children, one per source session
const workerSessions = new Map();
// Main distillation entry point — called on session.idle or when urgent
export async function run(input) {
    let rounds = 0;
    let distilled = 0;
    const model = input.model ?? undefined;
    const minRecords = config().memory.autoExtractBatchSize;
    const maxTokensPerBatch = 10000;
    // 从数据库读取所有待处理记录（不限制数量）
    const db = await getDatabase();
    const records = await db.queryPendingByProjectId(input.projectPath, input.sessionID);
    if (records.length === 0) {
        log.info(`[autoExtraction] no pending records found for project: ${input.projectPath}`);
        return { rounds, distilled };
    }
    // 记录数小于6则返回
    if (records.length < minRecords) {
        log.info(`[autoExtraction] records count ${records.length} < ${minRecords}, skip extraction, parent session id: ${input.sessionID}`);
        return { rounds, distilled };
    }
    log.info(`[autoExtraction] start now, parent session id: ${input.sessionID}`);
    distilled = records.length;
    // 计算总token预算：ceil(content长度/3)
    const totalContent = records.map((r) => r.content || '').join('');
    const totalTokens = Math.ceil(totalContent.length / 3);
    log.info(`[autoExtraction] total records: ${records.length}, total tokens: ${totalTokens}`);
    // 如果token超过10000，按轮次分批执行
    if (totalTokens > maxTokensPerBatch) {
        // 分批处理
        const batches = splitIntoBatches(records, maxTokensPerBatch);
        log.info(`[autoExtraction] tokens ${totalTokens} > ${maxTokensPerBatch}, split into ${batches.length} batches`);
        for (let i = 0; i < batches.length; i++) {
            const batchRecords = batches[i];
            rounds++;
            log.info(`[autoExtraction] processing batch ${i + 1}/${batches.length}, records: ${batchRecords.length}`);
            const batchContent = batchRecords
                .map((r) => `[${r.role}]: ${r.content}`)
                .join("\n\n")
                .slice(0, config().memory.autoExtractMaxLength);
            const userContent = `## Recent conversation messages (batch ${i + 1}/${batches.length}, ${batchRecords.length} records)\n\n${batchContent}\n\nExtract memories from the messages above.`;
            const responseText = await input.llm.promptForSubAgent(AUTO_EXTRACTION_PROMPT, userContent, { model, agentName: "auto-extraction", eventSource: input.options?.eventSource, traceInput: batchRecords });
            // 如果提取成功，更新记录状态为1
            if (responseText !== null) {
                const partIds = batchRecords.map(r => r.part_id);
                const updatedCount = await db.updateStatusByPartIds(partIds, 1);
                log.info(`[autoExtraction] batch ${i + 1} finished, updated ${updatedCount} records to status=1`);
            }
            else {
                log.warn(`[autoExtraction] batch ${i + 1} finished but failed, records status not changed`);
            }
        }
        log.info(`[autoExtraction] all batches completed, total rounds: ${rounds}, parent session id: ${input.sessionID}`);
    }
    else {
        // 单次处理
        rounds = 1;
        const messageText = records
            .map((r) => `[${r.role}]: ${r.content}`)
            .join("\n\n")
            .slice(0, config().memory.autoExtractMaxLength);
        const userContent = `## Recent conversation messages (last ~${records.length})\n\n${messageText}\n\nExtract memories from the messages above.`;
        const responseText = await input.llm.promptForSubAgent(AUTO_EXTRACTION_PROMPT, userContent, { model, agentName: "auto-extraction", eventSource: input.options?.eventSource, traceInput: records });
        // 如果提取成功，更新记录状态为1
        if (responseText !== null) {
            const partIds = records.map(r => r.part_id);
            const updatedCount = await db.updateStatusByPartIds(partIds, 1);
            log.info(`[autoExtraction] finish now, updated ${updatedCount} records to status=1, parent session id: ${input.sessionID}`);
        }
        else {
            log.warn(`[autoExtraction] finish now, but fail, records status not changed, parent session id: ${input.sessionID}`);
        }
    }
    return { rounds, distilled };
}
/**
 * 将记录按token预算分批
 * @param records 所有待处理记录
 * @param maxTokensPerBatch 每批最大token数
 * @returns 分批后的记录数组
 */
function splitIntoBatches(records, maxTokensPerBatch) {
    const batches = [];
    let currentBatch = [];
    let currentTokens = 0;
    for (const record of records) {
        const content = record.content || '';
        const recordTokens = Math.ceil(content.length / 3);
        // 如果单条记录就超过限制，单独成批
        if (recordTokens > maxTokensPerBatch) {
            // 先保存当前批次
            if (currentBatch.length > 0) {
                batches.push(currentBatch);
                currentBatch = [];
                currentTokens = 0;
            }
            // 单独成批
            batches.push([record]);
            continue;
        }
        // 如果加入当前记录会超过限制，开始新批次
        if (currentTokens + recordTokens > maxTokensPerBatch) {
            if (currentBatch.length > 0) {
                batches.push(currentBatch);
            }
            currentBatch = [record];
            currentTokens = recordTokens;
        }
        else {
            currentBatch.push(record);
            currentTokens += recordTokens;
        }
    }
    // 保存最后一批
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }
    return batches;
}
