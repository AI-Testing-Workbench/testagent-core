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
