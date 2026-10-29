import * as log from "./core/log.js";
import { sendTraceLog } from "./core/trace-log.js";
import { getDatabase } from "./core/db.js";
import { EmbeddingService, normalizeVector } from "./embedding/service.js";
import { cosineSimilarity, calcBm25KeywordBonus, buildCorpusStats } from "./vectorSearch.js";
import { buildFtsTokens } from "./tokenizer.js";
import { predictNoul, noulToBool } from "./predict.js";
// ==================== 推荐问题二次判定接口 ====================
// URL/超时并入公共 predict 模块（config().predict.*），判定阈值沿用公共阈配置。
// EmbeddingService 单例，延迟初始化避免启动时循环依赖
let _embeddingService = null;
async function getEmbeddingService() {
    if (!_embeddingService) {
        _embeddingService = new EmbeddingService();
    }
    return _embeddingService;
}
/**
 * 二次判定：调用 predict 接口比较用户问题与推荐问题是否为同一个问题。
 * @returns true: noul>阈值 认定为同一问题；false: 非同一问题；
 *          null: 接口不可访问/响应异常（调用方跳过接口调用，保留既有推荐）
 */
export async function sameQuestionCheck(query, recommendedQuestion) {
    const noul = await predictNoul({
        key: "same",
        instructions: `query和'${recommendedQuestion}'是否是语义相似的问题`,
        state: { question: query },
    });
    if (noul === null)
        return null;
    return noulToBool(noul);
}
// ==================== 内容解析工具 ====================
export function extractAnswersByQuestion(content) {
    const out = [];
    if (!content)
        return out;
    const unescaped = content.replace(/\\"/g, '"');
    const re = /"([^"]*)"="([^"]*)"/g;
    let m;
    while ((m = re.exec(unescaped)) !== null) {
        out.push({ question: m[1], answer: m[2] });
    }
    return out;
}
export function buildQuestionContent(input, outputText) {
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
    const pairs = extractAnswersByQuestion(outputText);
    if (pairs.length > 0) {
        pairs.forEach((p, i) => parts.push(`Answer[${i + 1}]: "${p.question}"="${p.answer}"`));
    }
    else if (outputText) {
        parts.push(`Answer: ${outputText}`);
    }
    return parts.join("\n") || "";
}
export function extractQuestionText(input) {
    if (!input)
        return null;
    const questions = input.questions;
    if (!questions || questions.length === 0)
        return null;
    return questions[0].question || null;
}
export function extractAnswerText(content) {
    if (!content)
        return null;
    const m = content.match(/="([^"]+)"/);
    return m ? m[1].trim() : null;
}
export function extractQuestionFromContent(content) {
    if (!content)
        return null;
    const m = content.match(/^Question: (.+)$/m);
    return m ? m[1].trim() : null;
}
function applyRecommendation(args, answerText, score, questionIndex = 0) {
    const firstOptions = args.questions?.[questionIndex]?.options;
    if (!firstOptions)
        return;
    const matched = firstOptions.find(o => o.label === answerText);
    if (matched) {
        const idx = firstOptions.indexOf(matched);
        if (idx > 0) {
            firstOptions.splice(idx, 1);
            firstOptions.unshift(matched);
        }
        matched.description = "推荐答案（基于历史记录）" + (matched.description || "");
        if (matched.label === "以上全部")
            matched.label = "以下全部";
        log.info(`[question recommend] reordered option "${answerText}" (score=${score.toFixed(3)})`);
    }
    else {
        const finalText = answerText === "以上全部" ? "以下全部" : answerText;
        firstOptions.unshift({ label: finalText, description: "推荐答案（基于历史记录）" });
        log.info(`[question recommend] inserted option "${finalText}" (score=${score.toFixed(3)})`);
    }
}
// ==================== 埋点 ====================
function sendSimilarAnswerInjectTrace(opts) {
    const model = opts.model;
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
            questionIndex: opts.questionIndex,
            candidate: opts.candidate,
            recommended: opts.recommended,
            options: opts.options,
        }),
        message_id: "",
        part_id: "",
    });
}
// ==================== 主入口 ====================
/**
 * 推荐问题答案：根据用户本次问题，从历史问答候选（关键词+向量 RRF 融合）中选择最相似
 * 的一条，并通过 predict 接口做二次判定（noul>0.7 认定为同一问题）后才注入推荐。
 *
 * 该函数会原地修改 args（把推荐答案选项置顶/插入），返回推荐记录列表供调用方跟踪。
 * 所有内部异常均被捕获并记录日志，不会向调用方抛出。
 */
export async function recommendQuestionAnswers(params) {
    const { callID, sessionID, projectPath, model, args } = params;
    const recs = [];
    try {
        log.info("Recommend Quesitons 原始数据", JSON.stringify(args));
        const qs = args.questions;
        if (!qs || qs.length === 0)
            return recs;
        const db = await getDatabase();
        const candidates = await db.queryQuestionCandidates(callID, projectPath);
        if (candidates.length === 0)
            return recs;
        const now = Date.now();
        // 批量预处理：把每条候选记录按 "题"="答" 拆成单题 unit，逐题参与打分
        const units = [];
        for (const c of candidates) {
            const pairs = extractAnswersByQuestion(c.content);
            for (const p of pairs) {
                if (!p.question.trim())
                    continue;
                units.push({
                    partId: c.partId,
                    sessionId: c.sessionId,
                    timeCreated: c.timeCreated,
                    content: c.content,
                    text: p.question.trim(),
                    answer: p.answer,
                });
            }
        }
        if (units.length === 0)
            return recs;
        const unitTexts = units.map(u => u.text);
        let unitVecs = null;
        try {
            const embedService = await getEmbeddingService();
            unitVecs = await embedService.getBatchEmbedding(unitTexts);
        }
        catch (e) {
            const err = e;
            log.error(`[recommendQuestionAnswers] embedService error:`, { message: err.message, stack: err.stack, error: err });
        }
        const allUnitTokens = unitTexts.map(text => buildFtsTokens(text, false));
        const corpusStats = buildCorpusStats(allUnitTokens);
        log.info("Recommend Quesitons corpusStats", JSON.stringify({
            docCount: corpusStats.docCount,
            avgDocLength: corpusStats.avgDocLength,
            sampleDocFreq: Array.from(corpusStats.docFreq.entries()).slice(0, 10)
        }));
        // 逐题推荐
        for (let qi = 0; qi < qs.length; qi++) {
            const q = qs[qi];
            const questionText = q.question;
            if (!questionText)
                continue;
            const options = q.options ?? [];
            let matched = null;
            // 1) exact match, same session
            for (const c of candidates) {
                if (c.sessionId !== sessionID)
                    continue;
                const hit = extractAnswersByQuestion(c.content).find(p => p.question === questionText);
                if (hit) {
                    matched = { answer: hit.answer, score: 999, candidate: c.content };
                    break;
                }
            }
            // 2) hybrid RRF across recent records
            if (!matched) {
                const queryTokens = buildFtsTokens(questionText, false);
                log.info("Recommend Quesitons queryTokens", queryTokens);
                let queryVec = null;
                try {
                    const embedService = await getEmbeddingService();
                    queryVec = await embedService.getSingleEmbedding(questionText);
                }
                catch (e) {
                    const err = e;
                    log.error(`[recommendQuestionAnswers] embedService error:`, { message: err.message, stack: err.stack, error: err });
                }
                if (!queryVec) {
                    log.warn("query vector is null, skip normalize");
                    continue; // 仅跳过当前问题，继续下一个
                }
                const queryNormalize = Array.from(normalizeVector(queryVec));
                const scored = [];
                const excludeQuesitons = [];
                for (let ui = 0; ui < units.length; ui++) {
                    let excludeFlag = false;
                    const text = unitTexts[ui];
                    const vec = (unitVecs?.[ui]) ? cosineSimilarity(queryNormalize, Array.from(normalizeVector(unitVecs[ui]))) : 0;
                    if (vec < 0.8) {
                        excludeFlag = true;
                    }
                    const textTokens = allUnitTokens[ui];
                    const kw = calcBm25KeywordBonus(queryTokens, textTokens, corpusStats);
                    if (kw < 0.35) {
                        excludeFlag = true;
                    }
                    if (excludeFlag) {
                        excludeQuesitons.push({ idx: ui, text, kw, vec });
                        continue;
                    }
                    const ageHours = (now - units[ui].timeCreated) / 3600000;
                    const time = Math.max(0, 1 - ageHours / 720);
                    scored.push({ idx: ui, text, kw, vec, time });
                }
                log.info("Recommend Quesitons Scored", { userQuestion: questionText, scored });
                log.info("ExcludeQuesitons Scored", { userQuestion: questionText, excludeQuesitons });
                if (scored.length === 0)
                    continue;
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
                    if (units[scored[i].idx].sessionId === sessionID)
                        s += 1 / (RRF_K + 1);
                    log.info("Recommend Quesitons 最终得分", { content: scored[i].text, s, kw: scored[i].kw, vec: scored[i].vec, time: scored[i].time });
                    if (s > bestScore) {
                        bestScore = s;
                        bestIdx = i;
                    }
                }
                // 阈值设为 0.04（约等于最好情况的 85%）
                if (bestIdx === -1 || bestScore < 0.04)
                    continue;
                const bestUnit = units[scored[bestIdx].idx];
                log.info("Recommend Quesitons 推荐答案", bestUnit.content);
                // 二次判定：调用 predict 接口确认推荐问题与用户本次问题是否为同一问题
                // noul > 0.7 认定为同一问题才注入推荐；否则直接跳过该推荐
                // 接口不可访问时 sameQuestionCheck 返回 null，跳过接口调用，保留既有推荐（不阻塞主流程）
                const sameFlag = await sameQuestionCheck(questionText, bestUnit.text);
                if (sameFlag === false) {
                    log.info("Recommend Quesitons 二次判定不通过，跳过推荐", { userQuestion: questionText, recommendedQuestion: bestUnit.text, noulLeThreshold: true });
                    continue;
                }
                matched = { answer: bestUnit.answer, score: bestScore, candidate: bestUnit.content };
            }
            if (matched && options.length > 0) {
                recs.push({ qi, answer: matched.answer });
                sendSimilarAnswerInjectTrace({
                    callID,
                    sessionID,
                    questionText,
                    questionIndex: qi,
                    options,
                    score: matched.score,
                    candidate: matched.candidate,
                    recommended: matched.answer,
                    model,
                });
                applyRecommendation(args, matched.answer, matched.score, qi);
            }
        }
        return recs;
    }
    catch (e) {
        const err = e;
        log.error(`[recommendQuestionAnswers] question recommend failed:`, { message: err.message, stack: err.stack, error: err });
        return recs;
    }
}
