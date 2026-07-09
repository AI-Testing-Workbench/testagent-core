import { scanMemoryFiles } from "./memoryScan.js";
import { getMemoryDir } from "./paths.js";
import { readMemoryContent, truncateMemoryContent } from "./recall.js";
import { chineseTokenizer, buildFtsTokens } from "./tokenizer.js";
import { readFileSync } from "fs";
// 向量维度：提升到 512 减少碰撞
const VECTOR_DIM = 512;
// 每个 token 映射到的哈希位置数，增加信息密度
const HASH_POSITIONS_PER_TOKEN = 3;
// 全局Embedding缓存，避免重复计算
const embeddingCache = new Map();
// 缓存最大容量，防止内存溢出
const MAX_CACHE_SIZE = 300;
// ====================== 配置项 ======================
// 各字段权重：描述 > 名称 > 内容 > 类型
const WEIGHT_DESC = 2.8;
const WEIGHT_NAME = 2.2;
const WEIGHT_FILENAME = 1.6;
const WEIGHT_TYPE = 1.1;
const WEIGHT_CONTENT = 1.0;
// 时间衰减：21天内有加分
const TIME_WINDOW_DAYS = 30;
const TIME_BONUS_FACTOR = 0.15;
// 关键词精确匹配加分
const KEYWORD_BONUS = 1.2;
// 子串匹配加分
const SUBSTRING_BONUS = 0.55;
// 前缀匹配加分
const PREFIX_BONUS = 0.12;
// n-gram 匹配加分
const NGRAM_BONUS = 0.14;
// 最小匹配阈值
export const DEFAULT_MIN_SCORE = 0.18;
// 文本截断上限
const TEXT_TRUNCATE_LEN = 800;
// =====================================================================
// Tokenizers moved to ./tokenizer.ts
// =====================================================================
// 2. 多位置 FNV-1a 哈希：每个 token 映射到多个维度，减少信息丢失
// =====================================================================
function hashStr(s, seed = 0) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
        h = Math.imul(h, 0x01000193); // 二次混合增加随机性
    }
    return h >>> 0;
}
// =====================================================================
// 3. 优化向量生成：多位置哈希 + 正负分布均衡 + 词频加权
// =====================================================================
function textToEmbeddingSync(text) {
    const cacheKey = text.slice(0, TEXT_TRUNCATE_LEN);
    // 缓存命中直接返回
    if (embeddingCache.has(cacheKey)) {
        return embeddingCache.get(cacheKey);
    }
    const vec = new Array(VECTOR_DIM).fill(0);
    const tokens = chineseTokenizer(cacheKey);
    // 统计词频，高频词给予更高权重
    const tokenFreq = new Map();
    for (const t of tokens) {
        tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
    }
    for (const t of tokens) {
        const freq = tokenFreq.get(t) || 1;
        // 使用不同 seed 生成多个哈希位置
        for (let i = 0; i < HASH_POSITIONS_PER_TOKEN; i++) {
            const h = hashStr(t, i);
            const pos = h % VECTOR_DIM;
            // 用哈希高位决定正负，确保正负分布均匀
            const sign = (h >> 15) & 1 ? 1 : -1;
            // 词长度加权 + 词频加权
            const weight = sign * Math.min(t.length / 3, 2) * Math.min(freq * 0.3, 1.5);
            vec[pos] += weight;
        }
    }
    // L2归一化，避免长文本向量偏大
    const norm = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0)) || 1;
    const normalized = vec.map((val) => val / norm);
    // 控制缓存大小，LRU简易淘汰
    if (embeddingCache.size >= MAX_CACHE_SIZE) {
        const firstKey = embeddingCache.keys().next().value;
        if (firstKey)
            embeddingCache.delete(firstKey);
    }
    embeddingCache.set(cacheKey, normalized);
    return normalized;
}
// =====================================================================
// 4. 余弦相似度：边界防护 + 精确计算
// =====================================================================
export function cosineSimilarity(vec1, vec2) {
    if (vec1.length !== vec2.length || vec1.length === 0)
        return 0;
    let dot = 0;
    let norm1 = 0;
    let norm2 = 0;
    // 同时计算点积+模长，减少循环次数
    for (let i = 0; i < vec1.length; i++) {
        dot += vec1[i] * vec2[i];
        norm1 += vec1[i] * vec1[i];
        norm2 += vec2[i] * vec2[i];
    }
    const n1 = Math.sqrt(norm1) || 1;
    const n2 = Math.sqrt(norm2) || 1;
    const sim = dot / (n1 * n2);
    // 限制在 [0,1] 区间
    return Math.max(0, Math.min(1, sim));
}
// =====================================================================
// 5. 加权构建记忆文本：名称/描述/类型/内容分层权重
// =====================================================================
function buildWeightedMemoryText(memory, content) {
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
    return parts.join("\n");
}
// =====================================================================
// 6. 多策略关键词匹配：精确词 + 子串 + 前缀 + n-gram
// =====================================================================
// 6.1 精确词匹配（使用 jieba 分词）
function calcKeywordBonus(query, text, queryTokens, textTokens) {
    const textSet = new Set(textTokens);
    let matchCount = 0;
    for (const t of queryTokens) {
        if (textSet.has(t))
            matchCount++;
    }
    if (queryTokens.length === 0)
        return 0;
    const matchRate = matchCount / queryTokens.length;
    return matchRate * KEYWORD_BONUS;
}
// 6.2 子串匹配
function calcSubstringBonus(query, text, queryTokens, textTokens) {
    const textLower = text.toLowerCase();
    let matchCount = 0;
    for (const t of queryTokens) {
        if (t.length >= 2 && textLower.includes(t)) {
            matchCount++;
        }
    }
    if (queryTokens.length === 0)
        return 0;
    const matchRate = matchCount / queryTokens.length;
    return matchRate * SUBSTRING_BONUS;
}
// 6.3 前缀匹配
function calcPrefixBonus(query, text, queryTokens, textTokens) {
    const textSet = new Set(textTokens);
    let matchCount = 0;
    for (const q of queryTokens) {
        if (q.length < 2)
            continue;
        for (const t of textSet) {
            if (t.startsWith(q) && t !== q) {
                matchCount++;
                break;
            }
        }
    }
    if (queryTokens.length === 0)
        return 0;
    const matchRate = matchCount / queryTokens.length;
    return matchRate * PREFIX_BONUS;
}
// 6.4 n-gram 重叠匹配
function calcNgramBonus(query, text, queryTokens, textTokens) {
    const queryBigrams = new Set();
    const textBigrams = new Set();
    for (const t of queryTokens) {
        if (t.length >= 2) {
            for (let i = 0; i <= t.length - 2; i++) {
                queryBigrams.add(t.substring(i, i + 2));
            }
        }
    }
    for (const t of textTokens) {
        if (t.length >= 2) {
            for (let i = 0; i <= t.length - 2; i++) {
                textBigrams.add(t.substring(i, i + 2));
            }
        }
    }
    if (queryBigrams.size === 0)
        return 0;
    let overlapCount = 0;
    for (const bg of queryBigrams) {
        if (textBigrams.has(bg))
            overlapCount++;
    }
    const overlapRate = overlapCount / queryBigrams.size;
    return overlapRate * NGRAM_BONUS;
}
// =====================================================================
// 7. 平滑时间衰减加分：21天内有加分，使用平滑衰减曲线
// =====================================================================
function calcTimeBonus(now, mtimeMs) {
    const dayMs = 86400000;
    const windowMs = TIME_WINDOW_DAYS * dayMs;
    const diff = now - mtimeMs;
    if (diff > windowMs)
        return 0;
    // 使用平滑衰减曲线：exp(-lambda * t)
    const lambda = Math.log(2) / (TIME_WINDOW_DAYS / 2 * dayMs);
    const decay = Math.exp(-lambda * diff);
    return decay * TIME_BONUS_FACTOR * decay;
}
// =====================================================================
// 8. 生成记忆唯一键
// =====================================================================
function getMemoryKey(memory) {
    const name = memory.name ?? memory.filename.replace(/\.md$/, "").replace(/.*\//, "");
    const type = memory.type ?? "user";
    return `${name}|${type}`;
}
// =====================================================================
// 主检索方法
// =====================================================================
export async function vectorfilter(worktree, sessionID, query, alreadySurfaced = new Set(), topNum, minScore = DEFAULT_MIN_SCORE) {
    try {
        const memoryDir = getMemoryDir(worktree);
        const allMemories = [
            //...scanMemoryFiles(getPersonalMemoryFile()),
            ...scanMemoryFiles(memoryDir),
        ];
        const now = Date.now();
        // 前置过滤已出现过的记忆
        const filteredMemories = allMemories.filter((mem) => {
            const key = getMemoryKey(mem);
            return !alreadySurfaced.has(key);
        });
        if (filteredMemories.length === 0)
            return [];
        // 查询向量只计算一次
        const queryVec = textToEmbeddingSync(query);
        const scoredList = [];
        for (const memory of filteredMemories) {
            try {
                const rawContent = readMemoryContent(memory.filePath);
                const content = truncateMemoryContent(rawContent);
                // 加权文本构建
                const fullText = buildWeightedMemoryText(memory, content);
                // 向量+基础语义分
                const memVec = textToEmbeddingSync(fullText);
                const baseSim = cosineSimilarity(queryVec, memVec);
                // 多策略关键词匹配
                const queryTokens = buildFtsTokens(query, true);
                const textTokens = buildFtsTokens(fullText, false);
                const keywordBonus = calcKeywordBonus(query, fullText, queryTokens, textTokens);
                const substringBonus = calcSubstringBonus(query, fullText, queryTokens, textTokens);
                const prefixBonus = calcPrefixBonus(query, fullText, queryTokens, textTokens);
                const ngramBonus = calcNgramBonus(query, fullText, queryTokens, textTokens);
                const timeBonus = calcTimeBonus(now, memory.mtimeMs);
                // 综合最终得分：向量语义 + 多策略关键词 + 时间新鲜度
                const finalScore = baseSim + keywordBonus + substringBonus + prefixBonus + ngramBonus + timeBonus;
                if (finalScore >= minScore) {
                    scoredList.push({
                        memory,
                        content,
                        score: finalScore,
                        baseSim,
                        timeBonus,
                        keywordBonus,
                        ngramBonus,
                        prefixBonus,
                        substringBonus,
                    });
                }
            }
            catch (err) {
                console.debug(`[vectorfilter] 处理记忆失败: ${memory.filePath}`, err);
            }
        }
        // 综合得分倒序，取TopN
        scoredList.sort((a, b) => b.score - a.score);
        const topMemories = scoredList.slice(0, topNum);
        let result = [];
        // const filePath = getPersonalMemoryFile();
        // const claudeContent: ClaudeProfileMatch[] = extractClaudeContent(query, filePath,minScore,20);
        // if (claudeContent.length > 0) {
        //   result.push({
        //     fileName: "PERSONA.md",
        //     filePath: filePath,
        //     name: 'Personal Global Memory',
        //     type: "user",
        //     description: 'Matched Personal Global Memory',
        //     content: claudeContent.map(item => item.content).join("\n"),
        //     ageInDays: Math.max(0, Math.floor((now - statSync(filePath).mtimeMs) / (1000 * 60 * 60 * 24))),
        //   });
        // }
        // 将向量检索结果添加到结果数组
        result.push(...topMemories.map((item) => ({
            fileName: item.memory.filename,
            filePath: item.memory.filePath,
            name: item.memory.name ?? "",
            type: item.memory.type ?? "user",
            description: item.memory.description ?? "",
            content: item.content,
            ageInDays: Math.max(0, Math.floor((now - item.memory.mtimeMs) / (1000 * 60 * 60 * 24))),
        })));
        // 返回结果数组
        return result;
    }
    catch (e) {
        console.error("[vectorfilter] 向量检索全局异常", e);
        return [];
    }
}
// CLAUDE.md 匹配配置
const CLAUDE_KEYWORD_BONUS = 0.25;
const CLAUDE_SUBSTRING_BONUS = 0.18;
const CLAUDE_PREFIX_BONUS = 0.12;
const CLAUDE_NGRAM_BONUS = 0.15;
const CLAUDE_STRUCTURE_BONUS = 0.10; // 结构加分：标题、列表项中的词权重更高
const MAX_LINE_NUM = 200;
// =====================================================================
// CLAUDE.md 解析与内容提取
// =====================================================================
// 解析 CLAUDE.md 文件，提取章节结构
function parseClaudeMd(content) {
    const sections = [];
    const lines = content.split("\n");
    const headings = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/^##\s+(.+)$/);
        if (match) {
            headings.push({ text: match[1].trim(), index: i });
        }
    }
    if (headings.length === 0) {
        // 没有标题，整个文件作为一个章节
        for (let i = 0; i < MAX_LINE_NUM; i++) {
            const line = lines[i];
            sections.push({
                name: "",
                content: line.trim()
            });
        }
        return sections;
    }
    // 按标题分割内容
    for (let i = 0; i < headings.length; i++) {
        const current = headings[i];
        const next = headings[i + 1] || { index: lines.length };
        const startLine = current.index + 1;
        const endLine = next.index;
        const sectionLines = lines.slice(startLine, endLine);
        const sectionContent = sectionLines.join("\n").trim();
        sections.push({
            name: current.text,
            content: sectionContent
        });
    }
    return sections;
}
// 计算查询与内容的匹配分数（使用 jieba 分词）
function calcClaudeMatchScore(query, content) {
    const queryTokens = buildFtsTokens(query, true);
    const contentTokens = buildFtsTokens(content, false);
    const contentSet = new Set(contentTokens);
    const matchedKeywords = [];
    let matchCount = 0;
    for (const token of queryTokens) {
        if (contentSet.has(token)) {
            matchCount++;
            matchedKeywords.push(token);
        }
    }
    if (queryTokens.length === 0)
        return { score: 0, matchedKeywords: [] };
    const matchRate = matchCount / queryTokens.length;
    const score = matchRate * KEYWORD_BONUS;
    return { score, matchedKeywords };
}
// 读取并解析 CLAUDE.md 文件
function readClaudeMd(filePath) {
    try {
        if (!filePath)
            return [];
        const content = readFileSync(filePath, "utf-8");
        return parseClaudeMd(content);
    }
    catch {
        console.debug(`[readClaudeMd] 无法读取 CLAUDE.md: ${filePath}`);
        return [];
    }
}
// =====================================================================
// CLAUDE.md 相关内容提取主方法
// =====================================================================
/**
 * 从 CLAUDE.md 文件中提取与查询相关的内容
 * @param query 查询词
 * @param filePath CLAUDE.md 文件路径，默认为 ~/.config/testagent/CLAUDE.md
 * @param minScore 匹配系数阈值，低于此分数的结果将被过滤
 * @param topNum 返回结果数量上限，默认为 10
 * @returns 匹配的内容列表，按匹配分数降序排列
 */
export function extractClaudeContent(query, filePath, minScore = 0.1, topNum = 20) {
    try {
        if (!query.trim())
            return [];
        const sections = readClaudeMd(filePath);
        if (sections.length === 0)
            return [];
        const results = [];
        for (const section of sections) {
            const { score, matchedKeywords } = calcClaudeMatchScore(query, section.content);
            if (score >= minScore) {
                results.push({
                    sectionName: section.name,
                    content: section.content,
                    score,
                    matchedKeywords,
                });
            }
        }
        // 按匹配分数降序排列
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topNum);
    }
    catch (e) {
        console.debug(`[extractClaudeContent] 无法读取 CLAUDE.md，原因: ${e}`);
        return [];
    }
}
