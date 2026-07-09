import { readFileSync } from "fs";
import { scanMemoryFiles } from "./memoryScan.js";
import { getMemoryDir } from "./paths.js";
import { vectorfilter } from "./vectorSearch.js";
import { buildFtsTokens } from "./tokenizer.js";
import * as log from "./core/log.js";
import { EmbeddingService } from "./embedding/service.js";
// EmbeddingService 单例，避免每次调用 searchHybrid 都 new 新实例导致缓存失效
const embeddingServiceInstance = new EmbeddingService();
const MAX_RECALLED_MEMORIES = 5;
const MAX_MEMORY_LINES = 200;
const MAX_MEMORY_BYTES = 4096;
const encoder = new TextEncoder();
export function readMemoryContent(filePath) {
    try {
        const raw = readFileSync(filePath, "utf-8");
        const trimmed = raw.trim();
        if (!trimmed.startsWith("---"))
            return trimmed;
        const lines = trimmed.split("\n");
        let closingIdx = -1;
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trimEnd() === "---") {
                closingIdx = i;
                break;
            }
        }
        return closingIdx === -1 ? trimmed : lines.slice(closingIdx + 1).join("\n").trim();
    }
    catch {
        return "";
    }
}
function scoreHeader(header, content, terms) {
    if (terms.length === 0)
        return 0;
    const nameHaystack = (header.name ?? "").toLowerCase();
    const descHaystack = (header.description ?? "").toLowerCase();
    const filenameHaystack = header.filename.toLowerCase();
    const contentHaystack = content.toLowerCase();
    let score = 0;
    const isPhraseTerm = (term) => term.includes(" ");
    for (const term of terms) {
        if (isPhraseTerm(term)) {
            if (descHaystack.includes(term))
                score += 8;
            if (nameHaystack.includes(term))
                score += 6;
            if (contentHaystack.includes(term))
                score += 3;
        }
        else {
            if (nameHaystack.includes(term))
                score += 5;
            if (descHaystack.includes(term))
                score += 7;
            if (filenameHaystack.includes(term))
                score += 2;
            if (contentHaystack.includes(term))
                score += 1;
        }
    }
    if (header.type === "user" && score > 0)
        score *= 1.2;
    if (header.type === "feedback" && score > 0)
        score *= 1.1;
    return Math.floor(score);
}
export function truncateMemoryContent(content) {
    const maxLines = content.split("\n").slice(0, MAX_MEMORY_LINES);
    const lineTruncated = maxLines.join("\n");
    if (encoder.encode(lineTruncated).length <= MAX_MEMORY_BYTES) {
        return lineTruncated;
    }
    const lines = lineTruncated.split("\n");
    const kept = [];
    let usedBytes = 0;
    for (const line of lines) {
        const candidate = kept.length === 0 ? line : `\n${line}`;
        const candidateBytes = encoder.encode(candidate).length;
        if (usedBytes + candidateBytes > MAX_MEMORY_BYTES)
            break;
        kept.push(line);
        usedBytes += candidateBytes;
    }
    return kept.join("\n");
}
// Port of Claude Code's findRelevantMemories pattern, adapted for
// keyword-based selection (no LLM side query available in plugin context).
function isToolReferenceMemory(header, content, recentTools) {
    if (recentTools.length === 0)
        return false;
    const type = header.type;
    if (type !== "reference")
        return false;
    const haystack = `${header.name ?? ""}\n${header.description ?? ""}\n${content}`.toLowerCase();
    const warningSignals = ["warning", "gotcha", "issue", "bug", "caveat", "pitfall", "known issue"];
    if (warningSignals.some((w) => haystack.includes(w)))
        return false;
    const toolHaystack = recentTools.map((t) => t.toLowerCase());
    return toolHaystack.some((tool) => haystack.includes(tool));
}
export async function recallRelevantMemoriesKeyWord(worktree, sessionID, partId, messageId, query, alreadySurfaced = new Set(), recentTools = [], maxResults = 5) {
    const memoryDir = getMemoryDir(worktree);
    const allMemories = scanMemoryFiles(memoryDir);
    if (!allMemories || allMemories.length === 0)
        return [];
    const memories = allMemories.filter((mem) => !alreadySurfaced.has(`${mem.name ?? mem.filename.replace(/\.md$/, "").replace(/.*\//, "")}|${mem.type ?? "user"}`));
    // 对query进行FTS预处理
    if (!query)
        return [];
    log.info(`[Jieba分词 start]`, query);
    const queryTokens = buildFtsTokens(query, true);
    if (!queryTokens || queryTokens.length === 0)
        return [];
    log.info(`[Jieba分词 end]`, JSON.stringify(queryTokens));
    // 发送 jieba 分词埋点日志
    // sendTraceLog({
    //   provider_id: "",
    //   model_id: "",
    //   session_id: sessionID,
    //   message_id: messageId,
    //   part_id: partId,
    //   p_session_id: "",
    //   user_query: query,
    //   agent_name: "main_agent",
    //   op_type: "jieba_tokenize",
    //   op_flag: queryTokens.length > 1 ? "S" : "F",
    //   event_source: "fts_tokenizer",
    //   start_time: traceStartTime,
    //   end_time: new Date(),
    //   input_content: JSON.stringify({
    //       query: query
    //     }),
    //   output_content: JSON.stringify(queryTokens),
    //   config_param: JSON.stringify(config()?.recall),
    // });
    // 这里不能只用 filter，必须用 map 来追加 content
    const filterMemories = memories.map((mem) => {
        // 读取并处理内容
        const rawContent = readMemoryContent(mem.filePath);
        const content = truncateMemoryContent(rawContent);
        // 返回一个 【新对象】，包含原来所有信息 + content
        return {
            ...mem,
            content: content,
        };
    }).filter((mem) => {
        const lowerName = mem.name?.toLowerCase();
        const lowerDescription = mem.description?.toLowerCase();
        const lowerContent = mem.content?.toLowerCase();
        return queryTokens.some((term) => lowerName?.includes(term) ||
            lowerDescription?.includes(term) ||
            lowerContent?.includes(term));
    });
    if (!filterMemories || filterMemories.length === 0)
        return [];
    const scored = filterMemories.map((mem) => {
        return {
            mem,
            score: scoreHeader(mem, mem.content, queryTokens),
        };
    });
    if (!scored || scored.length === 0)
        return [];
    if (queryTokens.length > 0 && scored.some((s) => s.score > 0)) {
        scored.sort((a, b) => b.score - a.score || b.mem.mtimeMs - a.mem.mtimeMs);
    }
    else {
        scored.sort((a, b) => b.mem.mtimeMs - a.mem.mtimeMs);
    }
    return scored.slice(0, maxResults).map(({ mem }) => {
        return {
            fileName: mem.filename,
            filePath: mem.filePath,
            name: mem.name ?? "",
            type: mem.type ?? "user",
            description: mem.description ?? "",
            content: mem.content,
            ageInDays: Math.max(0, Math.floor((Date.now() - mem.mtimeMs) / (1000 * 60 * 60 * 24))),
        };
    });
}
function formatAgeWarning(ageInDays) {
    if (ageInDays <= 1)
        return "";
    return `\n> This memory is ${ageInDays} days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.\n`;
}
export function formatRecalledMemories(memories) {
    if (memories.length === 0)
        return "";
    const sections = memories.map((memory) => {
        const ageWarning = formatAgeWarning(memory.ageInDays);
        return `### ${memory.name} (${memory.type})${ageWarning}\n${memory.content}`;
    });
    return [
        "## Recalled Memories ",
        "",
        "以下是当前对话召回的相关记忆",
        "",
        "The following memories were automatically selected as relevant to this conversation. They may be outdated — verify against current state before relying on them.",
        "",
        sections.join("\n\n"),
    ].join("\n");
}
let isFinding = false;
export async function recallRelevantMemoriesByLLM(llm, sessionID, partId, messageId, worktree, query, memories, model) {
    // 防重复执行锁
    if (isFinding)
        return [];
    isFinding = true;
    try {
        if (memories.length === 0) {
            return [];
        }
        log.info(`[LLM recall start]`, query);
        //模型召回
        const result = await selectRelevantMemories(llm, sessionID, partId, messageId, query, memories, model);
        log.info(`[LLM recall end]`, JSON.stringify(result));
        return result;
    }
    catch (e) {
        // 记录异常信息
        log.error(`[LLM recall 异常]`, e);
    }
    finally {
        // 释放锁
        isFinding = false;
    }
    return [];
}
async function selectRelevantMemories(llm, sessionID, partId, messageId, query, memories, model) {
    let recallRes = [];
    const traceStartTime = new Date();
    let errorMsg = "";
    const matchList = memories.map((item, index) => ({
        index,
        filename: item.fileName,
        name: item.name,
        description: item.description,
        type: item.type,
    }));
    const SELECT_MEMORIES_SYSTEM_PROMPT = `
  You are a file/memory matching engine. 
  # Task
  Select the top 5 most semantically relevant items from [memories List] that match the [Query].
  You may only match based on filename / name / description / type.

  # Query
  ${query}

  # memories List
  ${JSON.stringify(matchList, null, 2)}

  # Rules
  1. Return the index of the top 5 most relevant items.
  2. Do not include explanations, extra text, or scores.
  3. Sort strictly from highest to lowest relevance.
  4. If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
  5. If a list of [memories List] is null or empty, return an empty array.
  6. Output must be a pure JSON array, e.g. [0,2,3,1,4]. no think, no reasoning, no extra text.`;
    try {
        const result = await llm.prompt(SELECT_MEMORIES_SYSTEM_PROMPT, `Query: ${query}`, { model });
        if (!result || result.length === 0)
            return [];
        try {
            const parsed = JSON.parse(getLastBracketContent(result));
            if (!Array.isArray(parsed))
                return [];
            // 根据下标返回原对象
            recallRes = parsed
                .filter((i) => i >= 0 && i < memories.length)
                .slice(0, 5)
                .map((i) => memories[i]);
        }
        catch (e) {
            errorMsg = e instanceof Error ? e.message : String(e);
            return [];
        }
    }
    catch (e) {
        errorMsg = e instanceof Error ? e.message : String(e);
        return [];
    }
    finally {
        // const traceEndTime = new Date();
        // sendTraceLog({
        //   provider_id: model?.providerID || "",
        //   model_id: model?.modelID || "",
        //   session_id: sessionID || "",
        //   message_id: messageId || "",
        //   part_id: partId || "",
        //   p_session_id: sessionID,
        //   user_query: query,
        //   agent_name: "memory-recall",
        //   op_type: "llm_recall",
        //   op_flag: errorMsg? "F" : "S",
        //   event_source: "memory_recall",
        //   start_time: traceStartTime,
        //   end_time: traceEndTime,
        //   input_content: JSON.stringify({
        //       query: query,
        //       input_length: SELECT_MEMORIES_SYSTEM_PROMPT.length
        //     }),
        //   output_content: JSON.stringify(recallRes),
        //   other_content: errorMsg?JSON.stringify(errorMsg):"",
        //   prompt: SELECT_MEMORIES_SYSTEM_PROMPT,
        //   config_param: JSON.stringify(config()?.recall)
        // });
    }
    return recallRes;
}
/**
 * 截取字符串中最后一对 [] 里的全部内容（包含 [ 和 ] 符号）
 * @param str 原始字符串
 * @returns 最后一个括号内容，无则返回[]
 */
function getLastBracketContent(str) {
    const lastLeft = str.lastIndexOf('[');
    const lastRight = str.lastIndexOf(']');
    // 无括号 / 右括号在左括号左边 → 不合法
    if (lastLeft === -1 || lastRight === -1 || lastRight < lastLeft) {
        return '[]';
    }
    return str.substring(lastLeft, lastRight + 1);
}
// FTS tokenization moved to ./tokenizer.ts
/**
 * （关键词 + 向量）混合检索
 * @param worktree
 * @param sessionID
 * @param query
 * @param alreadySurfaced
 * @param maxResults
 * @returns
 */
export async function searchHybrid(worktree, sessionID, partId, messageId, query, alreadySurfaced, maxResults = 5) {
    const candidateK = maxResults * 3;
    // 对query进行FTS预处理
    //const processedQuery = buildFtsQuery(query)
    const [keywordHeaders, embeddingResult] = await Promise.all([
        (async () => {
            try {
                return recallRelevantMemoriesKeyWord(worktree, sessionID, partId, messageId, query, alreadySurfaced, [], candidateK);
            }
            catch {
                return [];
            }
        })(),
        (async () => {
            try {
                return await vectorfilter(worktree, sessionID, query, alreadySurfaced, candidateK, 0.3);
            }
            catch {
                return [];
            }
        })(),
        // (async () => {
        //   try {
        //     return await embeddingServiceInstance.retrieveMemory(worktree, sessionID, query, alreadySurfaced, candidateK, 0.3)
        //   } catch (e) {
        //     log.error(`[行内向量模型调用异常]`, e);
        //     try {
        //       return await vectorfilter(worktree, sessionID, query, alreadySurfaced, candidateK, 0.3)
        //     } catch {
        //       return [] as RecalledMemory[]
        //     }
        //   }
        // })(),
    ]);
    // RRF merge: k=60 is a standard constant from the RRF paper
    const RRF_K = 60;
    // Map: record_id → { rrfScore, formatable }
    const mergedMap = new Map();
    // Process keyword results
    for (let rank = 0; rank < keywordHeaders.length; rank++) {
        const r = keywordHeaders[rank];
        const id = r.filePath;
        const rrfScore = 1 / (RRF_K + rank + 1);
        const existing = mergedMap.get(id);
        if (existing) {
            existing.rrfScore += rrfScore;
        }
        else {
            mergedMap.set(id, { rrfScore, formatable: r });
        }
    }
    // Process embedding results
    for (let rank = 0; rank < embeddingResult.length; rank++) {
        const r = embeddingResult[rank];
        const id = r.filePath;
        const rrfScore = 1 / (RRF_K + rank + 1);
        const existing = mergedMap.get(id);
        if (existing) {
            existing.rrfScore += rrfScore;
        }
        else {
            mergedMap.set(id, { rrfScore, formatable: r });
        }
    }
    if (!mergedMap || mergedMap.size === 0)
        return [];
    // Sort by combined RRF score and take top results
    const sorted = [...mergedMap.entries()]
        .sort((a, b) => b[1].rrfScore - a[1].rrfScore)
        .slice(0, maxResults);
    if (sorted.length > 0) {
        return sorted.map(item => item[1].formatable);
    }
    return [];
}
