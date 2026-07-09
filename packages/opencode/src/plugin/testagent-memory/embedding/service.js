import { DEFAULT_MIN_SCORE } from "../vectorSearch.js";
import * as log from "../core/log.js";
// 接口基础配置
const EMBED_BASE_URL = "http://test-llm.platform.cmbchina.cn/v1/embeddings";
const EMBED_AUTH = "Bearer sk-yRpz0e5wBWcQujcKgEpPzg";
const EMBED_MODEL = "qwen3-embedding-0.6b";
export class EmbeddingService {
    /**
     * 记忆向量缓存，key 为 sessionID，value 为 { vectors: 向量数组, texts: 文本数组 }
     * 用于在同一个 session 会话中避免重复调用 getBatchEmbedding
     */
    memoryVectorCache = new Map();
    /**
     * 单个文本生成向量
     * @param text 待向量化文本
     * @returns 浮点向量数组
     */
    async getSingleEmbedding(text) {
        const res = await fetch(EMBED_BASE_URL, {
            method: "POST",
            headers: {
                "Authorization": EMBED_AUTH,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: EMBED_MODEL,
                input: text
            })
        });
        if (!res.ok) {
            log.error(`Embedding接口请求失败，状态码: ${res.status}`);
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
                "Authorization": EMBED_AUTH,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: EMBED_MODEL,
                input: texts
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
            // 动态导入所需模块
            const { scanMemoryFiles } = await import("../memoryScan.js");
            const { getMemoryDir } = await import("../paths.js");
            const { readMemoryContent, truncateMemoryContent } = await import("../recall.js");
            const { buildFtsTokens } = await import("../tokenizer.js");
            const { cosineSimilarity, calcKeywordBonus, calcSubstringBonus, calcNgramBonus, calcPrefixBonus, calcTimeBonus } = await import("../vectorSearch.js");
            const memoryDir = getMemoryDir(worktree);
            const allMemories = scanMemoryFiles(memoryDir);
            const now = Date.now();
            // 前置过滤已出现过的记忆
            const filteredMemories = allMemories.filter((mem) => {
                const name = mem.name ?? mem.filename.replace(/\.md$/, "").replace(/.*\//, "");
                const type = mem.type ?? "user";
                const key = `${name}|${type}`;
                return !alreadySurfaced.has(key);
            });
            if (filteredMemories.length === 0)
                return [];
            // 构建加权文本并批量生成向量
            const memoryTexts = [];
            const memoryIndexMap = new Map(); // 原始索引 -> 批量向量索引
            for (let i = 0; i < filteredMemories.length; i++) {
                const memory = filteredMemories[i];
                try {
                    const rawContent = readMemoryContent(memory.filePath);
                    const content = truncateMemoryContent(rawContent);
                    // 构建加权文本（与vectorfilter一致）
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
                    memoryIndexMap.set(memory.filePath, i);
                }
                catch (err) {
                    log.error(`[retrieveMemory] 处理记忆失败: ${memory.filePath}`, err);
                }
            }
            if (memoryTexts.length === 0)
                return [];
            // 检查缓存：同一个 session 会话不重复调用 getBatchEmbedding
            const cached = this.memoryVectorCache.get(sessionID);
            let memoryVectors;
            // if (cached && cached.texts.length === memoryTexts.length) {
            if (cached) {
                // 缓存命中，直接使用缓存的向量
                // log.info(`[retrieveMemory] Session ${sessionID} 缓存命中，跳过 getBatchEmbedding 调用`);
                memoryVectors = cached.vectors;
            }
            else {
                // 缓存未命中，调用 getBatchEmbedding 并更新缓存
                memoryVectors = await this.getBatchEmbedding(memoryTexts);
                this.memoryVectorCache.set(sessionID, { vectors: memoryVectors });
                // log.info(`[retrieveMemory] Session ${sessionID} 缓存未命中，已调用 getBatchEmbedding 并缓存结果`);
            }
            // 查询向量化
            const queryVec = await this.getSingleEmbedding(query);
            // 计算相似度并评分
            const scoredList = [];
            for (let i = 0; i < filteredMemories.length; i++) {
                const memory = filteredMemories[i];
                const filePath = memory.filePath;
                const vecIndex = memoryIndexMap.get(filePath);
                if (vecIndex === undefined || !memoryVectors[vecIndex]) {
                    continue;
                }
                try {
                    const rawContent = readMemoryContent(memory.filePath);
                    const content = truncateMemoryContent(rawContent);
                    // 向量相似度
                    const baseSim = cosineSimilarity(queryVec, memoryVectors[vecIndex]);
                    // 多策略关键词匹配
                    const fullText = memoryTexts[vecIndex];
                    const queryTokens = buildFtsTokens(query, true);
                    const textTokens = buildFtsTokens(fullText, false);
                    const keywordBonus = calcKeywordBonus(query, fullText, queryTokens, textTokens);
                    const substringBonus = calcSubstringBonus(query, fullText, queryTokens, textTokens);
                    const prefixBonus = calcPrefixBonus(query, fullText, queryTokens, textTokens);
                    const ngramBonus = calcNgramBonus(query, fullText, queryTokens, textTokens);
                    const timeBonus = calcTimeBonus(now, memory.mtimeMs);
                    // 综合得分
                    const finalScore = baseSim + keywordBonus + substringBonus + prefixBonus + ngramBonus + timeBonus;
                    if (baseSim >= minScore) {
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
            // 综合得分倒序，取TopN
            scoredList.sort((a, b) => b.score - a.score);
            const topMemories = scoredList.slice(0, topNum);
            //log.info(`\n 行内向量模型匹配结果 topMemories：\n${topMemories.map((item) => `${item.score}:${item.memory.filename};;${item.memory.name};;${item.memory.description}`).join('\n')}`);
            // 转换为RecalledMemory格式
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
