import { tool } from "@opencode-ai/plugin";
import { buildMemorySystemPrompt } from "./prompt.js";
import { searchHybrid, recallRelevantMemoriesByLLM, formatRecalledMemories } from "./recall.js";
import { cosineSimilarity, calcBm25KeywordBonus, buildCorpusStats } from "./vectorSearch.js";
import { buildFtsTokens } from "./tokenizer.js";
import { saveMemory, deleteMemory, listMemories, searchMemories, readMemory, MEMORY_TYPES, readPersonalMemory, savePersonalMemory, } from "./memory.js";
import { getMemoryDir, getOpencodeConfigHomeDir } from "./paths.js";
import { createOpenCodeRecallLLMClient } from "./recall-llm-adapter.js";
import { isWorkerSession } from "./core/worker.js";
import * as log from "./core/log.js";
import * as distillation from "./autoExtraction.js";
import { MessageBuffer } from "./core/messageBuffer.js";
import { createOpenCodeLLMClient } from "./core/llm-adapter.js";
import { CAPACITY } from "./core/constants.js";
import { runAutoDream } from "./autoDream.js";
import { runAutoPersonal } from "./autoPersonal.js";
import { initMemCmd } from "./core/initCommand.js";
import { load, config } from "./core/config.js";
import { sendTraceLog } from "./core/trace-log.js";
import { getDatabase } from "./core/db.js";
import { setExternalLog } from "./core/log.js";
import { recordHybridMetrics, recordLlmSuccess, recordLlmFailure, recordFinalSuccess, recordFinalFailure, logRecallMetrics } from "./recall.js";
import { EmbeddingService, normalizeVector } from "./embedding/service.js";
// EmbeddingService 单例，延迟初始化避免启动时循环依赖
let _embeddingService = null;
async function getEmbeddingService() {
    if (!_embeddingService) {
        _embeddingService = new EmbeddingService();
    }
    return _embeddingService;
}
let lastQuery;
let lastResult = false;
function shouldIgnoreMemoryContext(query) {
    if (query === lastQuery)
        return lastResult;
    lastQuery = query;
    lastResult = computeShouldIgnoreMemoryContext(query);
    return lastResult;
}
function computeShouldIgnoreMemoryContext(query) {
    // 如果查询为空，不忽略记忆上下文（正常对话需要记忆）
    if (!query)
        return false;
    // 统一转为小写并去除首尾空格，便于后续匹配
    const normalized = query.toLowerCase().trim();
    // ========================================================================
    // 过滤条件 1：命令模式 - 以 / 或 ! 开头的命令
    // 含义：匹配以斜杠 / 或感叹号 ! 开头的字符串，如 /help、!clear
    // 符号说明：^ 表示字符串开头，[\/!] 表示字符集合（匹配 / 或 ! 中的任意一个）
    // ========================================================================
    if (/^[\/!]/.test(normalized)) {
        return true;
    }
    // ========================================================================
    // 过滤条件 2：禁用记忆的命令模式 - 包含 "memory: off/disable"
    // 含义：匹配包含 "memory:" 后跟 off/disable/false/disabled 的配置命令
    // 符号说明：memory 字面匹配，\s* 匹配 0 个或多个空白字符，: 字面匹配
    //          (off|disable|false|disabled) 多选一，i 忽略大小写
    // 示例：memory: off、memory: disable、MEMORY: OFF
    // ========================================================================
    if (/memory\s*:\s*(off|disable|false|disabled)/i.test(normalized)) {
        return true;
    }
    // ========================================================================
    // 过滤条件 3：临时禁用标记 - 包含 --no-memory 等命令行参数
    // 含义：匹配包含 --no-memory、--skip-memory、--ignore-memory、--disable-memory 的标记
    // 符号说明：-- 字面匹配，| 表示或（多选一），i 忽略大小写
    // 示例：--no-memory、--skip-memory、--ignore-memory、--disable-memory
    // ========================================================================
    if (/--no-memory|--skip-memory|--ignore-memory|--disable-memory/i.test(normalized)) {
        return true;
    }
    // ========================================================================
    // 过滤条件 4：短问候语和简短回应 - 以问候语/回应开头和结尾的短句
    // 含义：匹配纯问候语或简短回应（确认/否定），通常不需要记忆上下文
    // 符号说明：^ 开头，$ 结尾，(a|b|c) 多选一，[!.]? 匹配可选的感叹号或句号
    //          normalized.length <= 2 额外过滤 2 字符以内的超短输入
    // 示例：hi、hello、你好、thanks、ok、bye、嗯、哦、yes、no、对、好
    // ========================================================================
    const shortReplies = /^(hi|hello|hey|hola|bonjour|你好|您好|嗨|哈喽|早上好|下午好|晚上好|thanks|thank you|谢谢|多谢|ok|okay|好的|收到|嗯|哦|bye|goodbye|再见|拜拜|yes|no|yep|nope|是|否|对|不对|行|不行|可以|不可以|好)[!.]?$/i;
    if (shortReplies.test(normalized) || normalized.length <= 2) {
        return true;
    }
    // ========================================================================
    // 过滤条件 5：清除/重置记忆意图 - 包含清除或重置记忆的动词
    // 含义：匹配包含 clear/reset/wipe/delete/remove 等动词后跟 memory 的查询
    // 符号说明：(a|b|c) 多选一，\s* 匹配 0 个或多个空白，(all\s+)? 可选的 "all "
    //          (the\s+)? 可选的 "the "，i 忽略大小写
    // 示例：clear memory、reset all memory、清空记忆、删除记忆
    // ========================================================================
    if (/(clear|reset|wipe|delete|remove|清空|重置|清除)\s*(all\s+)?(the\s+)?memory/i.test(normalized)) {
        return true;
    }
    // ========================================================================
    // 过滤条件 6：明确要求忽略记忆 - 包含 ignore/don't use/skip 等动词
    // 含义：匹配包含 ignore/don't use/do not use/without/skip/no need for/不需要/不用
    //       等动词后跟 memory 的查询
    // 符号说明：(a|b|c) 多选一，\s+ 匹配 1 个或多个空白，(the\s+)? 可选的 "the "
    // 示例：ignore memory、don't use memory、不需要记忆、不用记忆
    // ========================================================================
    if (/(ignore|don't use|do not use|without|skip|no need for|不需要|不用)\s+(the\s+)?memory/i.test(normalized)) {
        return true;
    }
    // ========================================================================
    // 过滤条件 7：记忆应被忽略的被动语态 - memory 作为主语
    // 含义：匹配 "memory should be ignored"、"memory must be ignored" 等被动语态
    // 符号说明：memory 字面匹配，\s+ 1 个或多个空白，(should be|must be|is|will be)? 可选短语
    //          \s* 0 个或多个空白，ignored 字面匹配
    // 示例：memory should be ignored、memory must be ignored、记忆应被忽略
    // ========================================================================
    if (/memory\s+(should be|must be|is|will be)?\s*ignored/i.test(normalized)) {
        return true;
    }
    // ========================================================================
    // 过滤条件 8：中文表达 - 忽略/关闭/不要记忆
    // 含义：匹配中文语境下忽略记忆的多种表达方式
    // 符号说明：(?:忽略|关闭|...) 非捕获分组（只匹配不保存），\s* 可选空白
    //          (?:记忆|memory) 匹配"记忆"或"memory"
    // 示例：忽略记忆、关闭记忆、不要记忆、不使用记忆、暂时忽略记忆、别用记忆
    // ========================================================================
    if (/(?:忽略|关闭|不要|不使用|不用|暂时忽略|别用)\s*(?:记忆|memory)/i.test(normalized)) {
        return true;
    }
    // ========================================================================
    // 过滤条件 9：保存记忆意图 - 用户希望保存而非召回记忆
    // 含义：匹配用户希望将内容保存到记忆的查询，这类查询不需要触发记忆召回
    // 符号说明：记住 中文字面，save 英文字面，(?:this\s*)? 可选的 "this "
    //          (?:to\s*)? 可选的 "to "，persist 持久化，记录/保存 中文字面
    // 示例：记住这个、save to memory、persist memory、帮我记一下、记下来
    // ========================================================================
    if (/记住|save\s*(?:this\s*)?(?:to\s*)?memory|persist\s*memory|记录\s*(?:到\s*)?记忆|保存\s*记忆|帮我记|记下来/i.test(normalized)) {
        return true;
    }
    // ========================================================================
    // 过滤条件 10：只记住特定内容 - 强调"只"记住某内容
    // 含义：匹配 "remember only X" 或 "only remember X" 这类只关注保存的查询
    // 符号说明：\b 单词边界（确保 remember 是独立单词），.* 匹配任意字符 0 次或多次
    //          \bonly\b 确保 only 是独立单词
    // 示例：remember this only、only remember this content
    // ========================================================================
    if (/\bremember\b.*\bonly\b|\bonly\b.*\bremember\b/i.test(normalized)) {
        return true;
    }
    // ========================================================================
    // 过滤条件 11：代码/错误分析 - 以 debug/分析/检查 等动词开头的查询
    // 含义：匹配用户请求调试代码、分析错误、检查日志等场景，通常不需要记忆上下文
    // 符号说明：^ 开头，(debug|调试|分析|...) 多选一，\s+ 1 个或多个空白
    //          (this\s+)? 可选的 "this "，(code|error|log|...) 多选一
    // 示例：debug this code、调试错误、分析日志、explain this error
    // ========================================================================
    if (/^(debug|调试|分析|检查|查看|explain|解释)\s*(this\s+)?(code|error|log|代码|错误|日志)/i.test(normalized)) {
        return true;
    }
    // ========================================================================
    // 过滤条件 12：停止/取消操作 - 以 stop/cancel/停止/取消 等动词开头
    // 含义：匹配用户请求停止、取消、中止、暂停某个操作的查询
    // 符号说明：^ 开头，$ 结尾，(stop|cancel|abort|...) 多选一，i 忽略大小写
    // 示例：stop、cancel、abort、quit、halt、pause、停止、取消、中止、暂停、停
    // ========================================================================
    if (/^(stop|cancel|abort|quit|halt|pause|停止|取消|中止|暂停|停)$/i.test(normalized)) {
        return true;
    }
    // 以上条件都不匹配，说明需要记忆上下文，返回 false
    return false;
}
function hashQuestion(question) {
    let hash = 0;
    for (let i = 0; i < question.length; i++) {
        const char = question.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}
function extractUserQuery(message) {
    if (!message || typeof message !== "object")
        return undefined;
    if ("content" in message) {
        const content = message.content;
        if (typeof content === "string")
            return content;
        if (content !== undefined)
            return JSON.stringify(content);
    }
    if ("parts" in message) {
        const parts = message.parts;
        if (Array.isArray(parts)) {
            const text = parts
                .map((part) => {
                if (!part || typeof part !== "object")
                    return "";
                return typeof part.text === "string"
                    ? part.text
                    : "";
            })
                .filter(Boolean)
                .join("\n")
                .trim();
            if (text)
                return text;
        }
    }
    return undefined;
}
function getLastUserQuery(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.info?.role !== "user")
            continue;
        const query = extractUserQuery(message);
        const sessionID = typeof message.info?.sessionID === "string" ? message.info.sessionID : undefined;
        const messageID = typeof message.info?.id === "string" ? message.info.id : undefined;
        // 从 user message 的 parts 中获取 partId
        let partId;
        if (message.parts && Array.isArray(message.parts)) {
            for (const part of message.parts) {
                if (part && typeof part === "object" && "id" in part) {
                    partId = part.id;
                    if (partId)
                        break;
                }
            }
        }
        return { query, sessionID, messageID, partId, messageIndex: i };
    }
    return {};
}
function isAutoMemoryPart(part) {
    if (!part || typeof part !== "object")
        return false;
    return typeof part.text === "string" &&
        part.text.includes("# Auto Memory");
}
// Parses "### <name> (<type>)" headers from the ## Recalled Memories section
// of system prompts. After compaction old system messages disappear, so
// the returned set naturally shrinks — no manual reset needed.
function extractSurfacedMemoryKeys(systemText) {
    const keys = new Set();
    const recalledSection = systemText.indexOf("## Recalled Memories");
    if (recalledSection === -1)
        return keys;
    const headerPattern = /^### (.+?) \((\w+)\)/gm;
    const section = systemText.slice(recalledSection);
    for (let match = headerPattern.exec(section); match !== null; match = headerPattern.exec(section)) {
        keys.add(`${match[1]}|${match[2]}`);
    }
    return keys;
}
// Only completed tools — matches Claude Code's collectRecentSuccessfulTools().
function extractRecentTools(messages) {
    const tools = [];
    const seen = new Set();
    for (const message of messages) {
        if (!message.parts || !Array.isArray(message.parts))
            continue;
        for (const part of message.parts) {
            if (!part || typeof part !== "object")
                continue;
            const p = part;
            if (p.type !== "tool" || !p.tool)
                continue;
            if (p.state?.status !== "completed")
                continue;
            if (seen.has(p.tool))
                continue;
            seen.add(p.tool);
            tools.push(p.tool);
        }
    }
    return tools;
}
function buildTurnID(sessionID, messageID, messageIndex, query) {
    return `${sessionID}:${messageID ?? `${messageIndex ?? -1}:${query ?? ""}`}`;
}
function isUsefulRecallQuery(query) {
    const trimmed = query?.trim();
    if (!trimmed)
        return false;
    if (/\s/.test(trimmed))
        return true;
    return trimmed.length >= 4;
}
/** 带时区偏移的当前时间（东八区） */
function nowWithTz() {
    return new Date(Date.now() + 8 * 60 * 60 * 1000);
}
async function startRecallPrefetch(llm, sessionID, partId, messageId, turnID, worktree, query, alreadySurfaced, recentTools, model) {
    if (!llm || !isUsefulRecallQuery(query))
        return undefined;
    const handle = {
        turnID,
        settled: false,
        consumed: false,
        result: [],
    };
    // 预计算时区偏移（8小时），避免重复计算
    const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
    const now = Date.now() + TZ_OFFSET_MS;
    const metrics = {
        sessionID,
        partId,
        messageId,
        userQuery: query,
        op_type: "memory-recall",
        // 混合检索指标
        hybridRecallSuccess: "",
        hybridRecallCount: 0,
        hybridRecallMemories: [],
        // LLM召回指标
        llmRecallEnabled: config()?.recall?.llmRecall ?? false,
        llmRecallModel: model ? `${model.providerID}/${model.modelID}` : undefined,
        llmRecallSuccess: "",
        llmRecallCount: 0,
        llmRecallMemories: [],
        llmRecallError: "",
        // 最终召回结果指标
        finalRecallSuccess: "",
        finalRecallCount: 0,
        finalRecallMemories: [],
        finalRecallError: "",
    };
    metrics.finalRecallStartTime = nowWithTz();
    try {
        // 异步获取混合检索结果
        const hybridStart = nowWithTz();
        const hybridMemories = await searchHybrid(worktree, sessionID, partId, messageId, query, alreadySurfaced, 10);
        // 记录混合检索指标
        metrics.hybridRecallSuccess = "S";
        recordHybridMetrics(metrics, hybridMemories, hybridStart);
        // LLM 召回逻辑 + 超时处理
        if (config()?.recall?.llmRecall) {
            let llmRecallFinish = false;
            const timeoutMs = config()?.recall?.llmRecallTimeout ?? 8000;
            // 启动 LLM 召回（后台执行，不阻塞返回）
            const timeoutPromise = new Promise((resolve) => {
                setTimeout(() => {
                    if (!llmRecallFinish) {
                        handle.result = [];
                        handle.settled = true;
                    }
                    resolve();
                }, timeoutMs);
            });
            const llmStart = nowWithTz();
            const llmPromise = recallRelevantMemoriesByLLM(createOpenCodeRecallLLMClient(llm, sessionID || ''), sessionID, partId, messageId, worktree, query, hybridMemories, model).then((llmResult) => {
                // LLM 召回完成，更新结果
                handle.result = llmResult;
                handle.settled = true;
                llmRecallFinish = true;
                recordLlmSuccess(metrics, llmResult, llmStart);
                recordFinalSuccess(metrics, handle.result, metrics.finalRecallStartTime);
                logRecallMetrics(metrics);
            }).catch((err) => {
                // LLM 召回失败，保持默认结果
                log.error(`[recallMemoryError]:`, { sessionID: sessionID, partId: partId, messageId: messageId, errorMsg: err });
                recordLlmFailure(metrics, err, llmStart);
                logRecallMetrics(metrics);
            });
            await Promise.race([llmPromise, timeoutPromise]);
        }
        else {
            // 关闭 LLM → 直接前 5 条
            handle.result = hybridMemories.slice(0, 5);
            handle.settled = true;
            recordFinalSuccess(metrics, handle.result, metrics.finalRecallStartTime);
            logRecallMetrics(metrics);
        }
    }
    catch (err) {
        // 出错兜底：返回空结果
        handle.result = [];
        handle.settled = true;
        log.error('[recallMemoryError]:', { sessionID: sessionID, partId: partId, messageId: messageId, errorMsg: err });
        recordFinalFailure(metrics, err, metrics.finalRecallStartTime);
    }
    return handle;
}
function consumeRecallPrefetch(ctx) {
    const prefetch = ctx?.recallPrefetch;
    if (!prefetch || !prefetch.settled || prefetch.consumed)
        return [];
    if (prefetch.result) {
        // prefetch.consumed = true
        return prefetch.result;
    }
    return [];
}
const states = new Map();
function getState(projectPath) {
    const existing = states.get(projectPath);
    if (existing)
        return existing;
    const state = {
        activeSessions: new Set(),
        skipSessions: new Set(),
        buffer: new MessageBuffer(),
        seen: new Set(),
        turnContextBySession: new Map(),
        modelCache: new Map(),
        distilling: false,
        lastExtraction: 0,
        turnsSinceCuration: 0,
        distillingMap: new Map(),
        recByCallID: new Map(),
    };
    states.set(projectPath, state);
    return state;
}
export const MemoryPlugin = async (params) => {
    // 设置外部日志适配器，使 log.info/log.error 等自动转发到 params.log
    setExternalLog(params.log);
    params.log?.("info", "MemoryPlugin initialized", { service: "offical-memory" });
    const worktreeOrigin = params.worktree || params;
    const directory = params.directory || params;
    const projectPath = directory || worktreeOrigin;
    const worktree = projectPath;
    log.info(`[prjPath]worktreeOrigin=${worktreeOrigin}, directory=${directory}`);
    // 等待配置加载完成
    await load(getOpencodeConfigHomeDir());
    log.info(`记忆插件配置`, JSON.stringify(config()));
    // 初始化或删除命令
    initMemCmd(projectPath);
    // 如果插件完全未启用（既未开启记忆，也未开启相似答案注入），直接返回空插件
    if (!config().enable && !config().similarAnswer.enable) {
        log.info("[MemoryPlugin] plugin is disabled, skipping initialization");
        return {};
    }
    // 初始化工作区记忆目录
    getMemoryDir(worktree);
    const state = getState(projectPath);
    const activeSessions = state.activeSessions;
    const skipSessions = state.skipSessions;
    const buffer = state.buffer;
    const turnContextBySession = state.turnContextBySession;
    const modelCache = state.modelCache;
    const seen = state.seen;
    const distillingMap = state.distillingMap;
    const recByCallID = state.recByCallID;
    async function shouldSkip(sessionID) {
        if (isWorkerSession(sessionID))
            return true;
        if (skipSessions.has(sessionID))
            return true;
        if (activeSessions.has(sessionID))
            return false; // already known good
        try {
            const session = await params.client.session.get({ path: { id: sessionID } });
            if (session.data?.parentID) {
                skipSessions.add(sessionID);
                return true;
            }
        }
        catch {
            // session.get failed (likely short ID or not found) — assume not a child.
        }
        // Cache as known-good so we never re-check this session.
        activeSessions.add(sessionID);
        return false;
    }
    // Background distillation — debounced, non-blocking
    async function autoExtraction(sessionID, eventSource) {
        // 通过distillingMap 中run判断是否已经在提取中
        log.info(`[autoExtraction] autoExtraction start, length: ${distillingMap.size}, distillingMap: ${JSON.stringify(distillingMap)}`);
        if (distillingMap.has(sessionID)) {
            const distillObj = distillingMap.get(sessionID);
            if (distillObj?.run) {
                return;
            }
        }
        else {
            distillingMap.set(sessionID, { run: false, lastExtraction: 0 });
        }
        const distillObj = distillingMap.get(sessionID);
        if (!distillObj) {
            log.error(`[autoExtraction] distillObj is null`);
            return;
        }
        distillObj.run = true;
        distillingMap.set(sessionID, distillObj);
        //state.distilling = true;
        // 缓存满足判断
        // log.info(`[autoExtraction] buffer.size: ${buffer.size}`);
        // if (buffer.size < config().memory.autoExtractBatchSize) {
        //   state.distilling = false;
        //   return;
        // }
        // 自动提取触发时间间隔判断
        const timeDiff = Date.now() - distillObj.lastExtraction;
        if (timeDiff < CAPACITY.MIN_EXTRACT_INTERVAL_MS) {
            distillObj.run = false;
            distillingMap.set(sessionID, distillObj);
            log.info(`[autoExtraction] autoExtraction skip, timeDiff: ${timeDiff}`);
            return;
        }
        try {
            await distillation.run({
                llm: createOpenCodeLLMClient(params.client, sessionID),
                projectPath,
                sessionID,
                buffer,
                model: modelCache.get("currentModel"),
                force: false,
                options: {
                    eventSource: eventSource,
                }
            });
            distillObj.lastExtraction = Date.now();
        }
        catch (e) {
            log.error("distillation error:", e);
        }
        finally {
            distillObj.run = false;
            distillingMap.set(sessionID, distillObj);
        }
    }
    // Track user turns for periodic curation
    // 记忆自动整理 
    async function autoDream(sessionID) {
        try {
            await runAutoDream({
                llm: createOpenCodeLLMClient(params.client, sessionID),
                projectPath,
                sessionID,
                model: modelCache.get("currentModel"),
                force: false,
                options: {
                    eventSource: "session.idle",
                }
            });
        }
        catch (e) {
            log.error("[autoDream] error:", e);
        }
    }
    // 个人全局记忆 
    async function autoPersonal(sessionID) {
        try {
            await runAutoPersonal({
                llm: createOpenCodeLLMClient(params.client, sessionID),
                projectPath,
                sessionID,
                model: modelCache.get("currentModel"),
                force: false,
                options: {
                    eventSource: "session.idle",
                }
            });
        }
        catch (e) {
            log.error("[autoPersonal] error:", e);
        }
    }
    // 公共函数：保存提取历史记录
    async function upsertMemExtractHisRecord(record) {
        try {
            const db = await getDatabase();
            const now = Date.now();
            await db.upsertMemExtractHis({
                project_id: projectPath,
                time_created: now,
                time_updated: now,
                ...record,
            });
        }
        catch (dbError) {
            log.error("[upsertMemExtractHisRecord] error: ", dbError);
        }
    }
    // 缓存对话信息
    async function appendBufferMessage(part) {
        try {
            if (!part || typeof part !== "object")
                return;
            // 处理 question tool 类型
            if (part.type === "tool" && part.tool === "question") {
                // fire-and-forget: don't block user choice
                (async () => {
                    try {
                        const p = part;
                        const callID = p.callID || p.id;
                        log.info("tool工具", p.callID);
                        if (!callID)
                            return;
                        const st = p.state || {};
                        const questionText = extractQuestionText(st.input);
                        const outputText = st.output ? JSON.stringify(st.output) : (st.error ? JSON.stringify(st.error) : null);
                        // build content: question + options + answer
                        const content = buildQuestionContent(st.input, outputText);
                        // 判断用户是否选择了推荐答案（仅日志）
                        const recommended = recByCallID.get(callID);
                        if (recommended != null) {
                            const userAnswer = extractAnswerText(content);
                            const adopted = userAnswer === recommended;
                            // log.info("[question recommend] user selected recommended = " + adopted, { callID, recommended, userAnswer, sessionID: part.sessionID });
                            const model = modelCache.get("currentModel");
                            if (adopted) {
                                sendTraceLog({
                                    user_query: buildQuestionContent(st.input, null),
                                    provider_id: model?.providerID ?? "",
                                    model_id: model?.modelID ?? "",
                                    session_id: part.sessionID || "",
                                    agent_name: "tool_question",
                                    op_type: "similar-answer-inject-use",
                                    op_flag: "S",
                                    event_source: "message.part.updated",
                                    input_content: recommended,
                                    output_content: userAnswer ?? "",
                                    other_content: JSON.stringify({ callID, recommended, userAnswer, adopted }),
                                    message_id: p.messageID || "",
                                    part_id: part.id || "",
                                });
                            }
                            recByCallID.delete(callID);
                        }
                        // always upsert to mem_extract_his
                        await upsertMemExtractHisRecord({
                            part_id: part.id,
                            session_id: part.sessionID,
                            message_id: p.messageID || "",
                            content,
                            role: "tool_question",
                            status: st.status === "error" ? 1 : 0,
                        });
                    }
                    catch (e) {
                        log.warn(`[question tool] fire-and-forget failed:`, e);
                    }
                })();
                return;
            }
            if (part.type !== "text")
                return;
            const text = typeof part.text === "string" ? part.text.trim() : "";
            if (!text)
                return;
            const messageID = typeof part.messageID === "string" ? part.messageID : "";
            if (part.synthetic === true)
                return;
            // 已经缓存过的消息 不再缓存 sessionid+messageId+partId
            const key = `${part.sessionID}:${messageID}:${part.id}`;
            if (seen.has(key))
                return;
            seen.add(key);
            const full = await params.client.session.message({
                path: { id: part.sessionID, messageID: messageID },
            });
            const role = full.data?.info?.role || "unknown";
            // 记录提取历史到数据库
            await upsertMemExtractHisRecord({
                part_id: part.id || "",
                session_id: part.sessionID || "",
                message_id: messageID,
                content: text,
                role: role,
                status: 0,
            });
        }
        catch (e) {
            log.error("[appendBufferMessage] error: ", e);
        }
    }
    return {
        config: async (input) => {
            const cfg = input;
            cfg.agent = {
                ...cfg.agent,
                "auto-extraction": {
                    hidden: true,
                    mode: "subagent",
                    description: "Review conversation message and extract any information worth remembering for future sessions",
                    permission: {
                        "*": "deny",
                        "memory_list": "allow",
                        "memory_search": "allow",
                        "memory_read": "allow",
                        "memory_save": "allow",
                        "memory_delete": "allow",
                    },
                },
                "auto-dream": {
                    hidden: true,
                    mode: "subagent",
                    description: "You are performing an auto-dream memory consolidation pass",
                    permission: {
                        "*": "deny",
                        "memory_list": "allow",
                        "memory_search": "allow",
                        "memory_read": "allow",
                        "memory_save": "allow",
                        "memory_delete": "allow",
                    },
                },
                "auto-personal-memory": {
                    hidden: true,
                    mode: "subagent",
                    description: "负责整理合并项目记忆，输出标准个人全局记忆",
                    permission: {
                        "*": "deny",
                        "memory_read": "allow",
                        "memory_personal_read": "allow",
                        "memory_list": "allow",
                        "memory_personal_save": "allow",
                    }
                },
                "memory-recall": {
                    hidden: true,
                    mode: "subagent",
                    description: "You are a file/memory matching engine.",
                    permission: {
                        "grep": "deny",
                        "glob": "deny",
                        "memory_search": "deny",
                    },
                    prompt: "You are a file/memory matching engine. Select the top 5 most semantically relevant items from [memories List] that match the [Query].You may only match based on filename / name / description / type",
                },
            };
        },
        event: async ({ event }) => {
            if (event.type === "message.updated") {
                const msg = event.properties.info;
                if (config().enable && config().memory.autoExtractEnable) {
                    // log.info(`message.updated msg: ${JSON.stringify(msg)}`);
                    // 子Agent的子session 跳过
                    if (await shouldSkip(msg.sessionID))
                        return;
                    try {
                        if ('tokens' in msg) {
                            log.debug(`[message.updated] tokens = ${JSON.stringify(msg.tokens)}`);
                        }
                        if (msg.id && msg.role) {
                            // 记录用户的session id, 不记录子session
                            activeSessions.add(msg.sessionID);
                            // 记录用户轮次
                            if (msg.role === "user") {
                                state.turnsSinceCuration++;
                                if (msg.model.providerID && msg.model.modelID) {
                                    modelCache.set("currentModel", { providerID: msg.model.providerID, modelID: msg.model.modelID });
                                }
                            }
                        }
                    }
                    catch (e) {
                        // Message may not be fetchable yet during streaming
                        log.warn(`message.updated: failed to fetch message ${msg.id} for session ${msg.sessionID.substring(0, 16)}:`, e);
                    }
                }
            }
            if (event.type === "message.part.updated") {
                const part = event.properties.part;
                if (!part || !part.sessionID)
                    return;
                if (config().enable || config().similarAnswer.enable) {
                    try {
                        // 子Agent的子session 跳过
                        if (await shouldSkip(part.sessionID))
                            return;
                        await appendBufferMessage(part);
                    }
                    catch (e) {
                        // Message may not be fetchable yet during streaming
                        log.warn(`message.part.updated: failed to fetch part ${part.id} from message ${part.messageID} for session ${part.sessionID.substring(0, 16)}:`, e);
                    }
                }
            }
            if (event.type === "session.idle") {
                const sessionID = event.properties.sessionID;
                if (config().enable) {
                    if (await shouldSkip(sessionID))
                        return;
                    log.info(`[session.idle] trigger now, session id: ${sessionID} , turnsSinceCuration is: ${state.turnsSinceCuration}`);
                    if (!activeSessions.has(sessionID)) {
                        log.info(`session ${sessionID.substring(0, 16)} idle but not in activeSessions — skipping`);
                        return;
                    }
                    // 触发自动提取
                    if (config().memory.autoExtractEnable) {
                        await autoExtraction(sessionID, "session.idle");
                    }
                    // 触发记忆整理
                    if (state.turnsSinceCuration >= 3) {
                        // 项目记忆整理
                        if (config().memory.autoDreamEnable) {
                            await autoDream(sessionID);
                        }
                        // 个人全局记忆整理
                        if (config().memory.personalMemoryEnable) {
                            await autoPersonal(sessionID);
                        }
                        state.turnsSinceCuration = 0;
                    }
                    else {
                        log.info(`[autoDream] skipped: ${state.turnsSinceCuration}/3 user turns since last auto dream`);
                    }
                }
            }
        },
        "tool.execute.before": async (input, output) => {
            // 检查相似答案注入开关
            if (!config().similarAnswer.enable)
                return;
            if (input.tool !== "question" || !output.args)
                return;
            // 注意：必须使用 await 等待异步操作完成，否则 output.args 的修改不会生效
            try {
                const args = output.args;
                log.info("Recommend Quesitons 原始数据", JSON.stringify(args));
                const qs = args.questions;
                if (!qs || qs.length === 0)
                    return;
                const questionText = qs[0].question;
                if (!questionText)
                    return;
                const db = await getDatabase();
                const candidates = await db.queryQuestionCandidates(input.callID, projectPath);
                if (candidates.length === 0)
                    return;
                const now = Date.now();
                // 1) exact match, same session
                for (const c of candidates) {
                    if (c.session_id !== input.sessionID)
                        continue;
                    const qMatch = c.content?.match(/^Question: (.+)$/m);
                    if (qMatch && qMatch[1].trim() === questionText) {
                        const aMatch = c.content?.match(/="([^"]+)"/);
                        const answer = aMatch?.[1]?.trim();
                        if (answer) {
                            if (args.questions?.[0]?.options)
                                recByCallID.set(input.callID, answer);
                            sendSimilarAnswerInjectTrace({
                                callID: input.callID,
                                sessionID: input.sessionID,
                                questionText,
                                options: qs[0].options ?? [],
                                score: 999,
                                candidate: c.content,
                                recommended: answer,
                            });
                            applyRecommendation(args, answer, 999);
                            return;
                        }
                    }
                }
                // 2) hybrid RRF across recent records
                const queryTokens = buildFtsTokens(questionText, false);
                log.info("Recommend Quesitons queryTokens", queryTokens);
                const embedService = await getEmbeddingService();
                const candidateTexts = candidates.map(c => c.content?.match(/^Question: (.+)$/m)?.[1]?.trim() || "");
                let queryVec = null;
                let candidateVecs = null;
                try {
                    [queryVec, candidateVecs] = await Promise.all([
                        embedService.getSingleEmbedding(questionText),
                        embedService.getBatchEmbedding(candidateTexts),
                    ]);
                }
                catch (e) {
                    const err = e;
                    log.error(`[tool.execute.before] embedService error:`, { message: err.message, stack: err.stack, error: err });
                }
                // 预先构建语料库统计信息（用于 BM25 计算）
                const allCandidateTokens = candidates.map(c => {
                    const text = c.content?.match(/^Question: (.+)$/m)?.[1]?.trim() || "";
                    return buildFtsTokens(text, false);
                });
                const corpusStats = buildCorpusStats(allCandidateTokens);
                log.info("Recommend Quesitons corpusStats", JSON.stringify({
                    docCount: corpusStats.docCount,
                    avgDocLength: corpusStats.avgDocLength,
                    sampleDocFreq: Array.from(corpusStats.docFreq.entries()).slice(0, 10)
                }));
                const scored = [];
                if (!queryVec) {
                    log.warn("query vector is null, skip normalize");
                    return; // 或者抛出错误、终止逻辑
                }
                const queryNormalize = Array.from(normalizeVector(queryVec));
                for (let ci = 0; ci < candidates.length; ci++) {
                    const text = candidateTexts[ci];
                    const textTokens = allCandidateTokens[ci];
                    const kw = calcBm25KeywordBonus(queryTokens, textTokens, corpusStats);
                    if (kw < 0.35)
                        continue;
                    const vec = (queryVec && candidateVecs?.[ci]) ? cosineSimilarity(queryNormalize, Array.from(normalizeVector(candidateVecs[ci]))) : 0;
                    if (vec < 0.65)
                        continue;
                    const ageHours = (now - candidates[ci].time_created) / 3600000;
                    const time = Math.max(0, 1 - ageHours / 720);
                    scored.push({ idx: ci, text, kw, vec, time });
                }
                if (scored.length === 0)
                    return;
                log.info("Recommend Quesitons Scored", { questionText, scored });
                const N = scored.length;
                // RRF (Reciprocal Rank Fusion) 融合排序
                // 公式：score = Σ (1 / (k + rank))，k 是常数参数
                const RRF_K = 60;
                const rankBy = (fn) => {
                    const ids = Array.from({ length: N }, (_, i) => i).sort((a, b) => fn(b) - fn(a));
                    const r = new Array(N);
                    for (let i = 0; i < N; i++)
                        r[ids[i]] = i + 1;
                    return r;
                };
                const kwR = rankBy(i => scored[i].kw);
                const vecR = rankBy(i => scored[i].vec);
                const timeR = rankBy(i => scored[i].time);
                // 计算每个候选的 RRF 融合得分
                let bestIdx = -1, bestScore = -1;
                for (let i = 0; i < N; i++) {
                    let s = (3 / (RRF_K + kwR[i])) + (6 / (RRF_K + vecR[i])) + (1 / (RRF_K + timeR[i]));
                    // 同 session 的候选给予额外奖励
                    if (candidates[scored[i].idx].session_id === input.sessionID)
                        s += 1 / (RRF_K + 1);
                    log.info("Recommend Quesitons 最终得分", { content: scored[i].text, s, kw: scored[i].kw, vec: scored[i].vec, time: scored[i].time });
                    if (s > bestScore) {
                        bestScore = s;
                        bestIdx = i;
                    }
                }
                // 阈值设为 0.04（约等于最好情况的 85%）
                if (bestIdx === -1 || bestScore < 0.04)
                    return;
                const bestCandidate = candidates[scored[bestIdx].idx];
                log.info("Recommend Quesitons 推荐答案", bestCandidate.content);
                const aMatch = bestCandidate.content?.match(/="([^"]+)"/);
                const answer = aMatch?.[1]?.trim();
                if (answer) {
                    if (args.questions?.[0]?.options)
                        recByCallID.set(input.callID, answer);
                    sendSimilarAnswerInjectTrace({
                        callID: input.callID,
                        sessionID: input.sessionID,
                        questionText,
                        options: qs[0].options ?? [],
                        score: bestScore,
                        candidate: bestCandidate.content,
                        recommended: answer,
                    });
                    applyRecommendation(args, answer, bestScore);
                }
            }
            catch (e) {
                const err = e;
                log.error(`[tool.execute.before] question recommend failed:`, { message: err.message, stack: err.stack, error: err });
            }
        },
        "experimental.session.compacting": async (_input, output) => {
            // 提取 sessionID
            const sessionID = (_input && typeof _input === "object" && "sessionID" in _input)
                ? _input.sessionID
                : undefined;
            log.debug(`session.compacting trigger now, session id: ${sessionID}`);
            if (sessionID) {
                // 压缩后消息已改变，重置该会话的上下文状态
                turnContextBySession.delete(sessionID);
                // 压缩时触发自动提取
                if (config().enable && config().memory.autoExtractEnable) {
                    if (await shouldSkip(sessionID))
                        return;
                    log.info(`[experimental.session.compacting] autoExtraction trigger now, session id: ${sessionID}`);
                    autoExtraction(sessionID, "experimental.session.compacting");
                }
            }
        },
        "experimental.chat.messages.transform": async (_input, output) => {
            if (!config().enable)
                return;
            const { query, sessionID, partId, messageID, messageIndex } = getLastUserQuery(output.messages);
            if (sessionID && isWorkerSession(sessionID))
                return;
            const ctx = sessionID ? turnContextBySession.get(sessionID) : undefined;
            const prevMessageCount = ctx ? ctx.prevMessageCount ?? 0 : 0;
            const isLoadSystemPrompt = ctx ? ctx.isLoadSystemPrompt ?? false : false;
            const alreadySurfaced = new Set();
            const recentTools = [];
            if (sessionID && ctx) {
                for (const key of ctx.alreadySurfaced) {
                    alreadySurfaced.add(key);
                }
                for (const t of ctx.recentTools) {
                    recentTools.push(t);
                }
            }
            for (let i = prevMessageCount; i < output.messages.length; i++) {
                const message = output.messages[i];
                const role = String(message.info.role);
                if (role !== "user")
                    continue;
                for (const part of message.parts) {
                    if (!part || typeof part !== "object")
                        continue;
                    const text = part.text;
                    if (typeof text === "string") {
                        for (const key of extractSurfacedMemoryKeys(text)) {
                            alreadySurfaced.add(key);
                        }
                    }
                }
            }
            const newRecentTools = extractRecentTools(output.messages.slice(prevMessageCount));
            for (const t of newRecentTools) {
                if (!recentTools.includes(t)) {
                    recentTools.push(t);
                }
            }
            if (sessionID) {
                const turnID = buildTurnID(sessionID, messageID, messageIndex, query);
                let recallPrefetch;
                if (config().recall.recallEnable && !shouldIgnoreMemoryContext(query) && query) {
                    recallPrefetch = ctx?.turnID === turnID
                        ? ctx.recallPrefetch
                        : await startRecallPrefetch(params.client, sessionID, partId || '', messageID || '', turnID, worktree, query, alreadySurfaced, recentTools, config()?.recall?.providerID ?
                            { providerID: config()?.recall?.providerID?.trim(), modelID: config()?.recall?.modelID?.trim() }
                            : modelCache.get("currentModel"));
                }
                const newCtx = { query, alreadySurfaced, recentTools, prevMessageCount: output.messages.length, isLoadSystemPrompt, turnID, recallPrefetch, partId, messageId: messageID };
                turnContextBySession.set(sessionID, newCtx);
            }
            if (!config().recall.recallEnable || shouldIgnoreMemoryContext(query)) {
                output.messages = output.messages
                    .map((message) => {
                    const role = String(message.info.role);
                    if (role !== "system")
                        return message;
                    const parts = message.parts.filter((part) => !isAutoMemoryPart(part));
                    return { ...message, parts };
                })
                    .filter((message) => message.
                    parts.length > 0);
            }
        },
        "experimental.chat.system.transform": async (_input, output) => {
            if (!config().enable)
                return;
            let sessionID;
            let isqwen3p = false;
            if (_input && typeof _input === "object") {
                sessionID = (typeof _input.sessionID === "string"
                    ? _input.sessionID
                    : undefined);
                if (_input?.model.id.includes("qwen3p")) {
                    isqwen3p = true;
                }
            }
            if (sessionID && isWorkerSession(sessionID))
                return;
            const ctx = sessionID ? turnContextBySession.get(sessionID) : undefined;
            const query = ctx?.query || '';
            const alreadySurfaced = ctx?.alreadySurfaced ?? new Set();
            const isLoadSystemPrompt = ctx?.isLoadSystemPrompt ?? false;
            const partId = ctx?.partId;
            const messageId = ctx?.messageId;
            //const isLoadSystemPrompt = false;
            const ignoreMemoryContext = !config().recall.recallEnable || shouldIgnoreMemoryContext(query);
            const recalled = ignoreMemoryContext ? [] : consumeRecallPrefetch(ctx);
            const recalledSection = formatRecalledMemories(recalled);
            log.info(`[system_prompt_build_for_recalled_memories] `, { sessionID: sessionID, partId: partId, messageId: messageId, recalledMemories: recalledSection });
            const memoryPrompt = buildMemorySystemPrompt(worktree, recalledSection, isLoadSystemPrompt, { includeIndex: !ignoreMemoryContext, });
            // 提示词不为空才追加
            if (typeof memoryPrompt === "string" && memoryPrompt.trim().length > 0) {
                // 不用判断query是否为空，解决压缩
                // if (output.system.length > 0 && isqwen3p) {
                //   output.system[0] += '\n\n'+ memoryPrompt;
                //   //log.info("qwen3p prompt",output.system[0])
                // } else {
                //   output.system.push(memoryPrompt);
                // }
                if (output.system.length > 0) {
                    output.system[0] += '\n\n' + memoryPrompt;
                }
            }
        },
        ...(config().enable
            ? {
                tool: {
                    memory_save: tool({
                        description: "Save or update a memory for future conversations. " +
                            "Each memory is stored as a markdown file with frontmatter. " +
                            "Use this when the user explicitly asks you to remember something, " +
                            "or when you observe important information worth preserving across sessions " +
                            "(user preferences, feedback, project context, external references). " +
                            "Check existing memories first with memory_list or memory_search to avoid duplicates." +
                            "Respond in the same language the user used in the conversation.",
                        args: {
                            file_name: tool.schema
                                .string()
                                .describe('File name for the memory (without .md extension). Use snake_case, e.g. "user_role", "feedback_testing_style", "project_auth_rewrite"'),
                            name: tool.schema.string().describe("Human-readable name for this memory"),
                            description: tool.schema
                                .string()
                                .describe("One-line description — used to decide relevance in future conversations, so be specific"),
                            type: tool.schema
                                .enum(MEMORY_TYPES)
                                .describe("Memory type: user (about the person), feedback (guidance on approach), project (ongoing work context), reference (pointers to external systems)"),
                            content: tool.schema
                                .string()
                                .describe("Memory content. For feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines"),
                        },
                        async execute(args) {
                            const filePath = await saveMemory(worktree, args.file_name, args.name, args.description, args.type, args.content);
                            return `Memory saved to ${filePath}`;
                        },
                    }),
                    memory_delete: tool({
                        description: "Delete a memory that is outdated, wrong, or no longer relevant. Also removes it from the index.",
                        args: {
                            file_name: tool.schema.string().describe("File name of the memory to delete (with or without .md extension)"),
                        },
                        async execute(args) {
                            const deleted = await deleteMemory(worktree, args.file_name);
                            return deleted ? `Memory "${args.file_name}" deleted.` : `Memory "${args.file_name}" not found.`;
                        },
                    }),
                    memory_list: tool({
                        description: "List all saved memories with their names, types, and descriptions. " +
                            "Use this to check what memories exist before saving a new one (to avoid duplicates).",
                        args: {},
                        async execute() {
                            const entries = listMemories(worktree);
                            if (entries.length === 0) {
                                return "No memories saved yet.";
                            }
                            const lines = entries.map((e) => `- **${e.name}** (${e.type}) [${e.fileName}]: ${e.description}`);
                            return `${entries.length} memories found:\n${lines.join("\n")}`;
                        },
                    }),
                    memory_search: tool({
                        description: "Search memories by keyword. Searches across names, descriptions, and content. " +
                            "Use this to find relevant memories before answering questions or when the user references past conversations.",
                        //"Use this only when no recalled memories are available — run memory search before answering questions or when the user references past conversations.",
                        args: {
                            query: tool.schema.string().describe("Search query — searches across name, description, and content"),
                        },
                        async execute(args) {
                            const results = searchMemories(worktree, args.query);
                            if (results.length === 0) {
                                return `No memories matching "${args.query}".`;
                            }
                            const lines = results.map((e) => `- **${e.name}** (${e.type}) [${e.fileName}]: ${e.description}\n  Content: ${e.content.slice(0, 200)}${e.content.length > 200 ? "..." : ""}`);
                            return `${results.length} matches for "${args.query}":\n${lines.join("\n")}`;
                        },
                    }),
                    memory_read: tool({
                        description: "Read the full content of a specific memory file.",
                        args: {
                            file_name: tool.schema.string().describe("File name of the memory to read (with or without .md extension)"),
                        },
                        async execute(args) {
                            const entry = readMemory(worktree, args.file_name);
                            if (!entry) {
                                return `Memory "${args.file_name}" not found.`;
                            }
                            return `# ${entry.name}\n**Type:** ${entry.type}\n**Description:** ${entry.description}\n\n${entry.content}`;
                        },
                    }),
                    memory_personal_read: tool({
                        description: "Read content from personal global memory file.",
                        args: {},
                        async execute(args) {
                            const memoryContent = readPersonalMemory();
                            if (!memoryContent) {
                                return "the personal global memory is empty";
                            }
                            return memoryContent;
                        },
                    }),
                    memory_personal_save: tool({
                        description: "Save or update personal global memory file." +
                            "Check existing personal global memory first with memory_personal_read to avoid duplicates.",
                        args: {
                            content: tool.schema.string().describe("personal global memory content")
                        },
                        async execute(args) {
                            return `Memory saved to ${savePersonalMemory(args.content)}`;
                        },
                    }),
                },
            } : {}),
    };
    function extractQuestionText(input) {
        if (!input)
            return null;
        const questions = input.questions;
        if (!questions || questions.length === 0)
            return null;
        return questions[0].question || null;
    }
    function buildQuestionContent(input, outputText) {
        const parts = [];
        if (!input)
            return outputText || "";
        const questions = input.questions;
        if (questions) {
            for (const q of questions) {
                if (q.question)
                    parts.push(`Question: ${q.question}`);
                if (q.options) {
                    for (const o of q.options) {
                        const line = o.description ? `${o.label} (${o.description})` : o.label;
                        parts.push(`  - ${line}`);
                    }
                }
            }
        }
        if (outputText) {
            const answer = (() => {
                try {
                    const p = JSON.parse(outputText);
                    return typeof p === "string" ? p : JSON.stringify(p);
                }
                catch {
                    return outputText;
                }
            })();
            parts.push(`Answer: ${answer}`);
        }
        return parts.join("\n") || "";
    }
    function extractAnswerText(content) {
        if (!content)
            return null;
        const m = content.match(/="([^"]+)"/);
        return m ? m[1].trim() : null;
    }
    function extractQuestionFromContent(content) {
        if (!content)
            return null;
        const m = content.match(/^Question: (.+)$/m);
        return m ? m[1].trim() : null;
    }
    function applyRecommendation(args, answerText, score) {
        const firstOptions = args.questions?.[0]?.options;
        if (!firstOptions)
            return;
        const matched = firstOptions.find(o => o.label === answerText);
        if (matched) {
            const idx = firstOptions.indexOf(matched);
            if (idx > 0) {
                firstOptions.splice(idx, 1);
                firstOptions.unshift(matched);
            }
            matched.description = "推荐答案（基于历史记录）" + matched.description || "推荐答案（基于历史记录）";
            if (matched.label === "以上全部")
                matched.label = "以下全部";
            log.info(`[question recommend] reordered option "${answerText}" (score=${score.toFixed(3)})`);
        }
        else {
            if (answerText === "以上全部")
                answerText = "以下全部";
            firstOptions.unshift({ label: answerText, description: "推荐答案（基于历史记录）" });
            log.info(`[question recommend] inserted option "${answerText}" (score=${score.toFixed(3)})`);
        }
    }
    function sendSimilarAnswerInjectTrace(opts) {
        const model = modelCache.get("currentModel");
        const userQuery = buildQuestionContent({ questions: [{ question: opts.questionText, options: opts.options }] }, null);
        sendTraceLog({
            user_query: userQuery,
            provider_id: model?.providerID ?? "",
            model_id: model?.modelID ?? "",
            session_id: opts.sessionID,
            agent_name: "tool_question",
            op_type: "similar-answer-inject",
            op_flag: "S",
            event_source: "tool.execute.before",
            input_content: opts.questionText,
            output_content: opts.recommended,
            other_content: JSON.stringify({
                callID: opts.callID,
                candidate: opts.candidate,
                recommended: opts.recommended,
                options: opts.options,
            }),
            message_id: "",
            part_id: "",
        });
    }
};
