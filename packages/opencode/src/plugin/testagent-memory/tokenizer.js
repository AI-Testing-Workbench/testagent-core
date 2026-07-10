import * as log from "./core/log.js";
// ── 正则表达式常量（避免重复编译） ──
const HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const TRIM_QUOTES = /^["']|["']$/g;
// ── Chinese stop words (based on HIT STOP WORDS LIST) ──
const ZH_STOP_WORDS = new Set([
    // 代词
    "我", "你", "他", "她", "它", "它们", "咱", "您", "咱们", "我们",
    "你们", "他们", "她们",
    "这", "这个", "这些", "那", "那个", "那些", "哪", "哪个", "哪些",
    "本", "此", "该", "其", "其他", "其它", "某", "某些",
    "自", "自己", "本身",
    // 动词
    "是", "有", "在", "为", "了", "着", "过", "被", "给", "让", "叫",
    "能", "会", "可以", "可能", "应该", "必须", "要", "需要", "想",
    "说", "看", "做", "去", "来", "走", "回", "起", "出", "进",
    "变", "成", "作为", "进行", "认为", "觉得", "知道",
    // 副词
    "不", "没", "没有", "非", "勿", "别",
    "都", "全", "总", "共", "尚", "还", "又", "再",
    "很", "非常", "十分", "太", "极", "最", "更", "较",
    "已", "已经", "曾经", "刚", "才", "就", "便", "立刻", "马上",
    "忽然", "突然", "终于", "居然",
    "光", "仅仅", "只", "只管", "单",
    "互相",
    // 连词
    "和", "及", "与", "同", "跟", "而", "而且", "以及",
    "或", "还是", "或者",
    "如果", "假如", "假使", "倘若", "要是",
    "因为", "由于",
    "所以", "因此", "因而", "故而", "从而",
    "虽然", "尽管",
    "但是", "然而", "可是", "不过",
    "既然",
    "不但", "不仅", "不只", "不光",
    "既",
    "哪怕", "无论",
    // 介词
    "在", "当", "把", "被", "对", "对于", "向", "往",
    "从", "自", "自从", "由",
    "跟", "同", "与", "和",
    "以", "用", "凭", "靠",
    "让", "叫",
    // 助词
    "的", "地", "得",
    "了", "着", "过",
    "吗", "吧", "呢", "啊", "呀", "哦", "噢", "呃", "嗯",
    "之", "所", "等", "等等", "之类",
    // 量词
    "个", "种", "些", "位", "名", "条", "张", "片", "部分",
    // 数词
    "一", "二", "三", "两", "四", "五", "六", "七", "八", "九", "十",
    "百", "千", "万", "亿",
    // 方位词
    "上", "下", "左", "右", "前", "后", "中", "里", "内", "外",
    "间", "边", "旁", "面", "头",
    // 其他
    "这", "那", "哪", "什么", "怎么", "怎样", "如何",
    "谁", "哪个人", "哪儿", "哪会儿", "几",
    "吗", "吧", "呢", "啊", "呀", "哎",
]);
// ── English stop words (based on NLTK stop word list, deduplicated) ──
const EN_STOP_WORDS = new Set([
    // Pronouns
    'i', 'me', 'my', 'myself',
    'we', 'our', 'ours', 'ourselves',
    'you', "you're", "you've", "you'll", "you'd", 'your', 'yours', 'yourself', 'yourselves',
    'he', 'him', 'his', 'himself',
    'she', "she's", 'her', 'hers', 'herself',
    'it', "it's", 'its', 'itself',
    'they', 'them', 'their', 'theirs', 'themselves',
    // Verbs
    'am', 'is', 'are', 'was', 'were',
    'be', 'been', 'being',
    'have', 'has', 'had', 'having',
    'do', 'does', 'did', 'doing',
    // Adjectives & Adverbs
    'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
    'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
    's', 't', 'just', 'now',
    // Contractions
    "don't", "aren't", "couldn't", "didn't", "doesn't", "hadn't", "hasn't",
    "haven't", "isn't", "mightn't", "mustn't", "needn't", "shan't", "shouldn't",
    "wasn't", "weren't", "won't", "wouldn't", "couldn't",
    // Conjunctions & Prepositions
    'and', 'but', 'if', 'or', 'because', 'as', 'until', 'while',
    'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under',
    'again', 'further', 'then', 'once',
    'here', 'there', 'when', 'where', 'why', 'how',
    // Additional common stop words
    'also', 'able', 'according', 'across', 'actually', 'almost', 'along',
    'already', 'always', 'among', 'another', 'anyone', 'anything',
    'away', 'back', 'based', 'big', 'bit', 'big', 'bit', 'both',
    'bring', 'build', 'come', 'could', 'course', 'day', 'days',
    'different', 'done', 'even', 'ever', 'every', 'example', 'fact',
    'far', 'felt', 'first', 'found', 'four', 'get', 'got', 'give',
    'go', 'going', 'good', 'great', 'half', 'hard', 'head', 'help',
    'high', 'hold', 'home', 'hour', 'however', 'keep', 'kind', 'known',
    'last', 'later', 'leave', 'less', 'let', 'life', 'light', 'line',
    'little', 'long', 'look', 'lot', 'low', 'make',
    'many', 'may', 'mean', 'might', 'miss', 'much', 'must', 'need',
    'never', 'next', 'number', 'offer', 'other', 'place', 'point',
    'problem', 'put', 'quite', 'rather', 'really', 'right', 'run',
    'say', 'see', 'seem', 'set', 'show', 'side', 'small', 'still',
    'take', 'tell', 'thing', 'think', 'three', 'time', 'today', 'top',
    'two', 'type', 'understand', 'use', 'used', 'using', 'want', 'way',
    'well', 'went', 'what', 'when', 'where', 'which', 'while', 'who',
    'whole', 'why', 'will', 'with', 'without', 'work', 'world', 'year',
    'yes', 'yet', 'you', 'your',
]);
// ── 合并中英文停用词，减少过滤时的查找次数 ──
const ALL_STOP_WORDS = new Set([...ZH_STOP_WORDS, ...EN_STOP_WORDS]);
// ── Chinese word segmentation (jieba) ──
// Lazy-loaded singleton: initialised on first call to `buildFtsTokens`.
// If @node-rs/jieba is unavailable, falls back to Unicode-regex splitting.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let _jieba; // undefined = not yet tried
function getJieba() {
    if (_jieba !== undefined)
        return _jieba;
    try {
        const jiebaModule = require("@node-rs/jieba");
        const { dict } = require("@node-rs/jieba/dict.js");
        _jieba = jiebaModule.Jieba.withDict(dict);
    }
    catch (e) {
        log.info(`[Jieba实例生成异常]`, e);
        _jieba = null;
    }
    return _jieba;
}
/**
 * jieba-based tokenizer for accurate Chinese word segmentation.
 *
 * Tokens are lowercased and filtered for stop words.
 */
export function buildFtsTokens(raw, isQuery) {
    // 输入校验
    if (!raw || typeof raw !== 'string')
        return [];
    const jieba = getJieba();
    let tokens;
    // 统一分词逻辑，减少重复代码
    if (jieba) {
        tokens = isQuery
            ? jieba.cutForSearch(raw, true)
            : jieba.cut(raw, true);
        tokens = tokens
            .map((t) => t.trim())
            .filter((t) => t && HAS_LETTER_OR_NUMBER.test(t));
        // jieba 路径：先去重，再统一后处理
        tokens = [...new Set(tokens)];
    }
    else {
        // 回退路径：使用正则分词，并应用相同的后处理逻辑
        tokens = raw
            .match(/[\p{L}\p{N}_]+/gu)
            ?.map((t) => t.trim())
            .filter((t) => t && HAS_LETTER_OR_NUMBER.test(t)) ?? [];
        tokens = [...new Set(tokens)];
    }
    if (tokens.length === 0)
        return [];
    // 统一后处理：小写 → 去引号 → 停用词过滤
    return tokens
        .map((token) => token.toLowerCase().replace(TRIM_QUOTES, ""))
        .filter((c) => c && !ALL_STOP_WORDS.has(c));
}
/**
 * Multi-granularity Chinese tokenizer: words + bigrams + single characters.
 * Kept for vector embedding where dense token coverage improves hashing.
 */
export function chineseTokenizer(text) {
    const clean = text
        .replace(/[^\u4e00-\u9fa5a-zA-Z0-9_\-]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    if (!clean)
        return [];
    const words = clean.split(" ").filter((t) => t.length >= 2 && t.length <= 30);
    const chineseChars = [];
    for (const char of clean) {
        if (char >= "\u4e00" && char <= "\u9fa5") {
            chineseChars.push(char);
        }
    }
    const bigrams = [];
    for (let i = 0; i < chineseChars.length - 1; i++) {
        bigrams.push(chineseChars[i] + chineseChars[i + 1]);
    }
    const singleChars = chineseChars.filter((c) => !ZH_STOP_WORDS.has(c));
    return [...words, ...bigrams, ...singleChars];
}
