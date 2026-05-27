import { readMemoryContent, truncateMemoryContent } from "./recall.js";
import { vectorfilter } from "./vectorSearch.js";
let isFinding = false;
export async function findRelevantMemories(llm, sessionID, worktree, query, isLLmRecall = false, alreadySurfaced, recentTools, model) {
    // 防重复执行锁
    if (isFinding)
        return [];
    isFinding = true;
    try {
        //向量检索初筛    
        const topNum = isLLmRecall ? 10 : 5;
        const memories = await vectorfilter(worktree, sessionID, query, alreadySurfaced, topNum, 0.3);
        //appendLog(worktree, sessionID, `向量检索召回集合：\n selectedHeaders: ${Array.from(memories ?? []).map(m => JSON.stringify(m)).join(", ") || "(none)"}\n`)
        if (memories.length === 0) {
            return [];
        }
        //模型召回
        let selectedHeaders = null;
        if (isLLmRecall) {
            //appendLog(worktree, sessionID, `LLM model: \n ${JSON.stringify(model)}\n`)
            selectedHeaders = await selectRelevantMemories(llm, query, memories, recentTools, model);
            //appendLog(worktree, sessionID, `LLM 召回集合：\n selectedHeaders: ${Array.from(selectedHeaders ?? []).map(m => JSON.stringify(m)).join(", ") || "(none)"}\n`)
            if (!selectedHeaders || selectedHeaders.length === 0) {
                return [];
            }
        }
        const now = Date.now();
        const results = [];
        const finalHeaders = selectedHeaders ?? memories;
        for (const header of finalHeaders) {
            try {
                const content = readMemoryContent(header.filePath);
                results.push({
                    fileName: header.filename,
                    filePath: header.filePath,
                    name: header.name ?? "",
                    type: header.type ?? "user",
                    description: header.description ?? "",
                    content: truncateMemoryContent(content),
                    ageInDays: Math.max(0, Math.floor((now - header.mtimeMs) / (1000 * 60 * 60 * 24))),
                });
            }
            catch {
            }
        }
        return results;
    }
    catch (e) {
        //appendLog(worktree, sessionID, `findRelevantMemories error：\n ${e}\n`, {logDir:'.opencode-memory-logs/llm-error-log'});
    }
    finally {
        // 释放锁
        isFinding = false;
    }
    return [];
}
async function selectRelevantMemories(llm, query, memories, recentTools, model) {
    const matchList = memories.map((item, index) => ({
        index,
        filename: item.filename,
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

# recentTools List
${JSON.stringify(recentTools, null, 2)}

# Rules
1. Return the index of the top 5 most relevant items.
2. Do not include explanations, extra text, or scores.
3. Sort strictly from highest to lowest relevance.
4. If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
5. If a list of [memories List] is null or empty, return an empty array.
6. If a list of [recentTools List] is provided, do not select memories that are usage reference or API documentation for those tools (OpenCode is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
7. Output must be a pure JSON array, e.g. [0,2,3,1,4]. no think, no reasoning, no extra text.`;
    try {
        const result = await llm.prompt(SELECT_MEMORIES_SYSTEM_PROMPT, `Query: ${query}`, { model });
        if (!result || result.length === 0)
            return null;
        try {
            const parsed = JSON.parse(getLastBracketContent(result));
            if (!Array.isArray(parsed))
                return null;
            // 根据下标返回原对象
            return parsed
                .filter((i) => i >= 0 && i < memories.length)
                .slice(0, 5)
                .map((i) => memories[i]);
        }
        catch {
            return null;
        }
    }
    catch (e) {
        return null;
    }
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
