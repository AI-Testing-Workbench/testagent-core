import * as log from "./log.js";
import { config } from "./config.js";
/**
 * 发送追踪日志
 * @param traceData 追踪日志数据
 * @returns 发送结果
 */
export async function sendTraceLog(traceData) {
    if (!config().trace.enable) {
        log.info("追踪日志功能未启用");
        return { success: false, message: "追踪日志功能未启用" };
    }
    try {
        // 处理 start_time 和 end_time，统一转为北京时间（+8小时）
        const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
        if (!traceData.start_time) {
            traceData.start_time = now;
        }
        else {
            traceData.start_time = new Date(traceData.start_time.getTime() + 8 * 60 * 60 * 1000);
        }
        traceData.start_time_ms = traceData.start_time.getTime();
        if (!traceData.end_time) {
            traceData.end_time = now;
        }
        else {
            traceData.end_time = new Date(traceData.end_time.getTime() + 8 * 60 * 60 * 1000);
        }
        traceData.end_time_ms = traceData.end_time.getTime();
        // 如果 total_ms 没有值，则使用 end_time - start_time 计算
        if (traceData.total_ms === undefined || traceData.total_ms === null) {
            const startTime = traceData.start_time instanceof Date ? traceData.start_time.getTime() : new Date(traceData.start_time).getTime();
            const endTime = traceData.end_time instanceof Date ? traceData.end_time.getTime() : new Date(traceData.end_time).getTime();
            traceData.total_ms = endTime - startTime;
        }
        log.callExternalLogOriginl("info", "trace-log-info", traceData);
        return { success: true, data: null };
    }
    catch (error) {
        log.error("追踪日志请求未知错误", error);
        return { success: false, message: "未知错误" };
    }
}
/**
 *
 * @param traceData 追踪日志数据
 * @param outputContent 可以使用自定义的输出内容
 * @returns 发送结果
 */
export async function traceLog(traceData, outputContent) {
    // 判断 traceData.output_content为空时， 将traceOuput 转为字符串
    if (!traceData.output_content) {
        traceData.output_content = JSON.stringify(outputContent);
    }
    return sendTraceLog(traceData);
}
