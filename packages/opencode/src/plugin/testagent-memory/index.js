import { tool } from "@opencode-ai/plugin";
import { buildMemorySystemPrompt } from "./prompt.js";
import { formatRecalledMemories } from "./recall.js";
import { saveMemory, deleteMemory, listMemories, searchMemories, readMemory, MEMORY_TYPES, readPersonalMemory, savePersonalMemory, } from "./memory.js";
import { getMemoryDir, getOpencodeConfigHomeDir } from "./paths.js";
import { findRelevantMemories } from "./findRelevantMemories.js";
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
function shouldIgnoreMemoryContext(query) {
    if (!query)
        return false;
    const normalized = query.toLowerCase();
    if (/^[\/!]/.test(normalized)) {
        return true;
    }
    return (/(ignore|don't use|do not use|without|skip)\s+(the\s+)?memory/.test(normalized) ||
        /memory\s+(should be|must be)?\s*ignored/.test(normalized) ||
        /(?:忽略|关闭|不要)\s*(?:记忆|memory)/.test(normalized) ||
        /记住|save\s*(?:this\s*)?(?:to\s*)?memory|persist\s*memory|记录\s*(?:到\s*)?记忆|保存\s*记忆/.test(normalized) ||
        /\bremember\b.*\bonly\b|\bonly\b.*\bremember\b/.test(normalized));
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
        return { query, sessionID, messageID, messageIndex: i };
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
function startRecallPrefetch(llm, sessionID, turnID, worktree, query, alreadySurfaced, recentTools, model) {
    if (!llm || !isUsefulRecallQuery(query))
        return undefined;
    const handle = {
        turnID: turnID,
        settled: false,
        consumed: false,
        result: [],
    };
    const promise = findRelevantMemories(createOpenCodeRecallLLMClient(llm, sessionID || ""), sessionID || "", worktree, query, config()?.recall?.llmRecall ?? false, alreadySurfaced, recentTools, model);
    void promise.then((result) => {
        handle.result = result;
    }).finally(() => {
        handle.settled = true;
    });
    return handle;
}
function consumeRecallPrefetch(ctx) {
    const prefetch = ctx?.recallPrefetch;
    if (!prefetch || !prefetch.settled || prefetch.consumed)
        return [];
    prefetch.consumed = true;
    return prefetch.result;
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
        turnContextBySession: new Map(),
        modelCache: new Map(),
        distilling: false,
        lastExtraction: 0,
        turnsSinceCuration: 0,
    };
    states.set(projectPath, state);
    return state;
}
export const MemoryPlugin = async (params) => {
    const worktreeOrigin = params.worktree || params;
    const directory = params.directory || params;
    const projectPath = directory || worktreeOrigin;
    const worktree = projectPath;
    log.info(`[prjPath]worktreeOrigin=${worktreeOrigin}, directory=${directory}`);
    getMemoryDir(worktree);
    // 等待配置加载完成
    await load(getOpencodeConfigHomeDir());
    // 如果插件未启用，直接返回空插件
    if (!config().enable) {
        //log.info("[MemoryPlugin] plugin is disabled, skipping initialization");
        return {};
    }
    // 初始化命令
    initMemCmd();
    const state = getState(projectPath);
    const activeSessions = state.activeSessions;
    const skipSessions = state.skipSessions;
    const buffer = state.buffer;
    const turnContextBySession = state.turnContextBySession;
    const modelCache = state.modelCache;
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
    async function autoExtraction(sessionID) {
        if (state.distilling)
            return;
        state.distilling = true;
        // 缓存满足判断
        log.info(`[autoExtraction] buffer.size: ${buffer.size}`);
        if (buffer.size < config().memory.autoExtractBufferSize) {
            state.distilling = false;
            return;
        }
        // 自动提取触发时间间隔判断
        const timeDiff = Date.now() - state.lastExtraction;
        log.info(`[autoExtraction] last extract pass second: ${Math.floor(timeDiff / 1000)}`);
        if (timeDiff < CAPACITY.MIN_EXTRACT_INTERVAL_MS) {
            state.distilling = false;
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
            });
            state.lastExtraction = Date.now();
        }
        catch (e) {
            log.error("distillation error:", e);
        }
        finally {
            state.distilling = false;
        }
    }
    // 记忆自动整理 
    async function autoDream(sessionID) {
        try {
            await runAutoDream({
                llm: createOpenCodeLLMClient(params.client, sessionID),
                projectPath,
                sessionID,
                model: modelCache.get("currentModel"),
                force: false,
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
            });
        }
        catch (e) {
            log.error("[autoPersonal] error:", e);
        }
    }
    // 缓存对话信息
    async function appendBufferMessage(part) {
        try {
            if (!part || typeof part !== "object")
                return;
            if (part.type !== "text")
                return;
            const text = typeof part.text === "string" ? part.text : "";
            if (!text)
                return;
            const messageID = typeof part.messageID === "string" ? part.messageID : "";
            if (part.synthetic === true)
                return;
            const full = await params.client.session.message({
                path: { id: part.sessionID, messageID: messageID },
            });
            let role = "unknown";
            if (full.data && full.data.info) {
                role = full.data.info.role;
            }
            buffer.push({ role, content: text, timestamp: Date.now() });
            log.info(`[message.part.updated] buffer size is: ${buffer.size}`);
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
                },
                "auto-dream": {
                    hidden: true,
                    mode: "subagent",
                    description: "You are performing an auto-dream memory consolidation pass",
                },
                "auto-personal-memory": {
                    hidden: true,
                    mode: "subagent",
                    description: "负责整理合并项目记忆，输出标准个人全局记忆",
                    tools: {
                        "memory_save": false,
                        "memory_delete": false,
                        "memory_read": false,
                        "memory_personal_read": true,
                        "memory_list": true,
                        "memory_personal_save": true,
                    },
                },
                "memory-recall": {
                    hidden: true,
                    mode: "subagent",
                    description: "You are a file/memory matching engine.",
                },
            };
        },
        event: async ({ event }) => {
            if (event.type === "message.updated") {
                const msg = event.properties.info;
                if (config().enable) {
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
                if (config().enable) {
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
                        await autoExtraction(sessionID);
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
        "experimental.session.compacting": async (_input, output) => {
            // 提取 sessionID
            const sessionID = (_input && typeof _input === "object" && "sessionID" in _input)
                ? _input.sessionID
                : undefined;
            log.debug(`session.compacting trigger now, session id: ${sessionID}`);
            if (sessionID) {
                // 压缩后消息已改变，重置该会话的上下文状态
                turnContextBySession.delete(sessionID);
            }
        },
        "experimental.chat.messages.transform": async (_input, output) => {
            if (!config().enable)
                return;
            const { query, sessionID, messageID, messageIndex } = getLastUserQuery(output.messages);
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
                        : startRecallPrefetch(params.client, sessionID, turnID, worktree, query, alreadySurfaced, recentTools, config()?.recall?.providerID ?
                            { providerID: config()?.recall?.providerID?.trim(), modelID: config()?.recall?.modelID?.trim() }
                            : modelCache.get("currentModel"));
                }
                const newCtx = { query, alreadySurfaced, recentTools, prevMessageCount: output.messages.length, isLoadSystemPrompt, turnID, recallPrefetch };
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
            //const isLoadSystemPrompt = false;
            const ignoreMemoryContext = !config().recall.recallEnable || shouldIgnoreMemoryContext(query);
            const recalled = ignoreMemoryContext ? [] : consumeRecallPrefetch(ctx);
            const recalledSection = formatRecalledMemories(recalled);
            //appendLog(worktree, sessionID || '', `召回 recalledSection: \n ${recalledSection}`);
            // for (const key of extractSurfacedMemoryKeys(recalledSection)) {
            //   alreadySurfaced.add(key)
            // }
            const memoryPrompt = buildMemorySystemPrompt(worktree, recalledSection, isLoadSystemPrompt, { includeIndex: !ignoreMemoryContext, });
            // if (ctx && !isLoadSystemPrompt) {
            //   ctx.isLoadSystemPrompt = true
            // }
            // 提示词不为空才追加
            if (typeof memoryPrompt === "string" && memoryPrompt.trim().length > 0) {
                // 不用判断query是否为空，解决压缩
                if (output.system.length > 0 && isqwen3p) {
                    output.system[0] += '\n\n' + memoryPrompt;
                    //log.info("qwen3p prompt",output.system[0])
                }
                else {
                    output.system.push(memoryPrompt);
                }
            }
        },
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
                    const filePath = saveMemory(worktree, args.file_name, args.name, args.description, args.type, args.content);
                    return `Memory saved to ${filePath}`;
                },
            }),
            memory_delete: tool({
                description: "Delete a memory that is outdated, wrong, or no longer relevant. Also removes it from the index.",
                args: {
                    file_name: tool.schema.string().describe("File name of the memory to delete (with or without .md extension)"),
                },
                async execute(args) {
                    const deleted = deleteMemory(worktree, args.file_name);
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
    };
};
