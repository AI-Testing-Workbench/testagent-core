import { DEFAULT_MIN_SCORE } from "../vectorSearch.js";
import * as log from "../core/log.js";
/**
 * 归一化向量。写入和搜索时必须使用相同归一化方式。
 * 归一化后向量模长为 1，余弦距离退化为 1 - 内积，是 sqlite-vec 的前置条件。
 */
export function normalizeVector(vec) {
    const arr = vec.map(v => Number.isFinite(v) ? v : 0);
    const mag = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
    if (mag < 1e-10)
        return new Float32Array(arr);
    return new Float32Array(arr.map(v => v / mag));
}
// ==================== API 调用向量模型 ====================
// 接口基础配置
const EMBED_BASE_URL = "http://test-llm.platform.cmbchina.cn/v1/embeddings";
const EMBED_MODEL = "qwen3-embedding-0.6b";
const EMBED_MI_CODE = "QmVhcmVyIHNrLXlScHowZTV3QldjUXVqY0tnRXBQemc=";
function getDecodedAuthToken() {
    return Buffer.from(EMBED_MI_CODE, "base64").toString("utf-8");
}
export class EmbeddingService {
    buildQueryPrompt(text) {
        return `query: ${text}`;
    }
    /**
     * 单个文本生成向量
     * @param text 待向量化文本
     * @returns 浮点向量数组
     */
    async getSingleEmbedding(text) {
        const res = await fetch(EMBED_BASE_URL, {
            method: "POST",
            headers: {
                "Authorization": getDecodedAuthToken(),
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: EMBED_MODEL,
                input: this.buildQueryPrompt(text)
            })
        });
        if (!res.ok) {
            throw new Error(`Embedding接口请求失败，状态码: ${res.status}`);
        }
        const data = await res.json();
        return data.data[0].embedding;
    }
    /**
     * 批量文本生成向量（推荐入库使用，减少请求）
     * @param texts 文本数组
     * @returns 按输入顺序对应的向量数组
     */
    async getBatchEmbedding(texts) {
        const res = await fetch(EMBED_BASE_URL, {
            method: "POST",
            headers: {
                "Authorization": getDecodedAuthToken(),
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: EMBED_MODEL,
                input: texts.map((t) => this.buildQueryPrompt(t))
            })
        });
        if (!res.ok) {
            log.error(`批量Embedding请求失败，状态码: ${res.status}`);
        }
        const data = await res.json();
        // 按 index 排序保证顺序和输入一致
        const sorted = data.data.sort((a, b) => a.index - b.index);
        return sorted.map((item) => item.embedding);
    }
    /**
     * 记忆召回主方法
     * 参考vectorfilter方法的签名和实现
     * @param worktree 工作树路径
     * @param sessionID 会话ID
     * @param query 用户提问文本
     * @param alreadySurfaced 已展示的记忆集合
     * @param topNum 返回前N条
     * @param minScore 最小匹配分数（默认0.18）
     * @returns 召回的记忆列表
     */
    async retrieveMemory(worktree, sessionID, query, alreadySurfaced = new Set(), topNum, minScore = DEFAULT_MIN_SCORE) {
        try {
            const { scanMemoryFiles } = await import("../memoryScan.js");
            const { getMemoryDir } = await import("../paths.js");
            const { readMemoryContent, truncateMemoryContent } = await import("../recall.js");
            const { buildFtsTokens } = await import("../tokenizer.js");
            const { cosineSimilarity, calcKeywordBonus, calcSubstringBonus, calcNgramBonus, calcPrefixBonus, calcTimeBonus } = await import("../vectorSearch.js");
            const { getDatabase } = await import("../core/db.js");
            const memoryDir = getMemoryDir(worktree);
            const allMemories = scanMemoryFiles(memoryDir);
            const now = Date.now();
            const filteredMemories = allMemories.filter((mem) => {
                const name = mem.name ?? mem.filename.replace(/\.md$/, "").replace(/.*\//, "");
                const type = mem.type ?? "user";
                const key = `${name}|${type}`;
                return !alreadySurfaced.has(key);
            });
            if (filteredMemories.length === 0)
                return [];
            // 从 SQLite 加载已存储的向量和缓存内容
            const db = await getDatabase();
            const storedVectors = db.getAllMemoryVectors(worktree);
            const vectorByFilename = new Map(storedVectors.map(v => [v.filePath, v.vector]));
            const contentByFilename = new Map(storedVectors.map(v => [v.filePath, v.content]));
            const memoryTexts = [];
            const memoryIndexMap = new Map();
            const cachedContentByPath = new Map();
            for (let i = 0; i < filteredMemories.length; i++) {
                const memory = filteredMemories[i];
                try {
                    // 优先用 DB 缓存的内容，否则读磁盘
                    let content = contentByFilename.get(memory.filename);
                    let isCached = true;
                    if (content === undefined) {
                        const rawContent = readMemoryContent(memory.filePath);
                        content = truncateMemoryContent(rawContent);
                        isCached = false;
                    }
                    if (isCached) {
                        cachedContentByPath.set(memory.filePath, content);
                    }
                    const WEIGHT_DESC = 2.8;
                    const WEIGHT_NAME = 2.2;
                    const WEIGHT_FILENAME = 1.6;
                    const WEIGHT_TYPE = 1.1;
                    const WEIGHT_CONTENT = 1.0;
                    const parts = [];
                    if (memory.name) {
                        parts.push(`【名称】${memory.name} `.repeat(Math.round(WEIGHT_NAME)));
                    }
                    if (memory.description) {
                        parts.push(`【描述】${memory.description} `.repeat(Math.round(WEIGHT_DESC)));
                    }
                    if (memory.filename) {
                        parts.push(`【文件名】${memory.filename} `.repeat(Math.round(WEIGHT_FILENAME)));
                    }
                    if (content) {
                        parts.push(`【内容】${content} `.repeat(Math.round(WEIGHT_CONTENT)));
                    }
                    if (memory.type) {
                        parts.push(`【类型】${memory.type} `.repeat(Math.round(WEIGHT_TYPE)));
                    }
                    const fullText = parts.join("\n");
                    memoryTexts.push(fullText);
                    // 只在 SQLite 有此记忆的向量时才加入索引
                    const vec = vectorByFilename.get(memory.filename);
                    if (vec) {
                        memoryIndexMap.set(memory.filePath, i);
                    }
                }
                catch (err) {
                    log.error(`[retrieveMemory] 处理记忆失败: ${memory.filePath}`, err);
                }
            }
            if (memoryIndexMap.size === 0)
                return [];
            // 查询向量（仍需调用 API），L2 归一化后与库中已归一化向量做余弦
            const queryVec = await this.getSingleEmbedding(query);
            // 维度校验：与库中首条向量维度对比
            if (storedVectors.length > 0) {
                const storedDim = storedVectors[0].vector.length;
                if (queryVec.length !== storedDim) {
                    log.error(`[retrieveMemory] 向量维度不匹配: 库中 ${storedDim}，查询 ${queryVec.length}`);
                    return [];
                }
            }
            const queryNorm = Array.from(normalizeVector(queryVec));
            const scoredList = [];
            for (let i = 0; i < filteredMemories.length; i++) {
                const memory = filteredMemories[i];
                const filePath = memory.filePath;
                const vecIndex = memoryIndexMap.get(filePath);
                if (vecIndex === undefined)
                    continue;
                const vec = vectorByFilename.get(memory.filename);
                if (!vec)
                    continue;
                try {
                    // 优先用 DB 缓存内容，否则读磁盘
                    let content = cachedContentByPath.get(filePath);
                    if (content === undefined) {
                        const rawContent = readMemoryContent(memory.filePath);
                        content = truncateMemoryContent(rawContent);
                    }
                    const baseSim = cosineSimilarity(queryNorm, vec);
                    const fullText = memoryTexts[vecIndex];
                    const queryTokens = buildFtsTokens(query, true);
                    const textTokens = buildFtsTokens(fullText, false);
                    const keywordBonus = calcKeywordBonus(query, fullText, queryTokens, textTokens);
                    const substringBonus = calcSubstringBonus(query, fullText, queryTokens, textTokens);
                    const prefixBonus = calcPrefixBonus(query, fullText, queryTokens, textTokens);
                    const ngramBonus = calcNgramBonus(query, fullText, queryTokens, textTokens);
                    const timeBonus = calcTimeBonus(now, memory.mtimeMs);
                    // 综合最终得分：向量语义（权重0.7）+ 多策略关键词（权重0.3）
                    const VEC_WEIGHT = 0.7;
                    const BONUS_WEIGHT = 0.3;
                    const finalScore = baseSim * VEC_WEIGHT + (keywordBonus + substringBonus + prefixBonus + ngramBonus + timeBonus) * BONUS_WEIGHT;
                    if (finalScore >= minScore) {
                        scoredList.push({
                            memory,
                            content,
                            score: finalScore
                        });
                    }
                }
                catch (err) {
                    log.error(`[retrieveMemory] 处理记忆失败: ${memory.filePath}`, err);
                }
            }
            scoredList.sort((a, b) => b.score - a.score);
            const topMemories = scoredList.slice(0, topNum);
            return topMemories.map((item) => ({
                fileName: item.memory.filename,
                filePath: item.memory.filePath,
                name: item.memory.name ?? "",
                type: item.memory.type ?? "user",
                description: item.memory.description ?? "",
                content: item.content,
                ageInDays: Math.max(0, Math.floor((now - item.memory.mtimeMs) / (1000 * 60 * 60 * 24))),
            }));
        }
        catch (e) {
            log.error("[retrieveMemory] 向量检索全局异常", e);
            return [];
        }
    }
}
