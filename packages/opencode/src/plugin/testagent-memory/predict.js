import * as log from "./core/log.js";
import { config } from "./core/config.js";
import { sendTraceLog } from "./core/trace-log.js";
/**
 * 调用 predict 接口执行 noul 语义判定。
 * @returns noul 数值（0~1，≥0 有效）；接口不可访问/非200/响应缺字段/超时时返回 null。
 *          返回 null 表示接口调用失败，由调用方决定兜底行为。
 */
export async function predictNoul(params) {
    const cfg = config();
    const url = cfg.predict?.url;
    const startMs = Date.now();
    const state = params.state ?? {};
    const key = params.key;
    // 记录调用输入（query 语料 + instructions），便于事后审计
    const recordTrace = (opFlag, outputContent, extra) => {
        void sendTraceLog({
            user_query: JSON.stringify(state),
            provider_id: "",
            model_id: "",
            session_id: "",
            agent_name: "predict_noul",
            op_type: `predict-noul-${key}`,
            op_flag: opFlag,
            event_source: "predict.predictNoul",
            start_time: new Date(startMs),
            end_time: new Date(),
            input_content: params.instructions,
            output_content: outputContent,
            other_content: JSON.stringify({
                key,
                url,
                state,
                ...extra,
            }),
            message_id: "",
            part_id: "",
            total_ms: Date.now() - startMs,
        });
    };
    if (!url) {
        log.warn(`[predictNoul] 未配置 predict.url，跳过接口调用`);
        recordTrace("F", "no predict.url configured");
        return null;
    }
    const timeoutMs = cfg.predict?.timeoutMs ?? 1500;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    state,
                    questions: {
                        [key]: {
                            type: "noul",
                            instructions: params.instructions,
                        },
                    },
                }),
                signal: controller.signal,
            });
            if (!res.ok) {
                log.warn(`[predictNoul] predict 接口非200，跳过接口调用: ${res.status}`);
                recordTrace("F", `http ${res.status}`);
                return null;
            }
            const data = (await res.json());
            const noul = data?.answers?.[key]?.noul;
            if (typeof noul !== "number" || Number.isNaN(noul)) {
                log.warn(`[predictNoul] predict 响应缺少 answers.${key}.noul，跳过接口调用`, JSON.stringify(data).slice(0, 500));
                recordTrace("F", `missing answers.${key}.noul`);
                return null;
            }
            recordTrace("S", String(noul), { response: data });
            return noul;
        }
        finally {
            clearTimeout(timer);
        }
    }
    catch (e) {
        log.warn(`[predictNoul] predict 接口不可访问，跳过接口调用:`, e);
        recordTrace("F", "request exception", { error: String(e) });
        return null;
    }
}
/** 便捷：noul > threshold 判定布尔 */
export function noulToBool(noul, threshold) {
    return noul > (threshold ?? 0.7);
}
