/**
 * 追踪日志接口请求参数
 */
export interface TraceLogRequest {
    /** 用户查询内容 */
    user_query?: string;
    /** 提供商ID */
    provider_id: string;
    /** 模型ID */
    model_id: string;
    /** 会话ID */
    session_id: string;
    /** 代理名称 */
    agent_name: string;
    /** 父会话ID */
    p_session_id?: string;
    /** 操作类型 */
    op_type: string;
    /** 成功(S)或者失败(F) */
    op_flag: "S" | "F";
    /** 事件来源 */
    event_source: string;
    /** 开始时间 */
    start_time?: Date;
    /** 结束时间 */
    end_time?: Date;
    /** 配置参数 */
    config_param?: string;
    /** 输入内容 */
    input_content: string;
    /** 输出内容 */
    output_content: string;
    /** 其他内容 */
    other_content?: string;
    /** 提示词 */
    prompt?: string;
    /** 消息ID */
    message_id: string;
    /** 部分ID */
    part_id?: string;
    /** 总耗时  */
    total_ms?: number;
    start_time_ms?: number;
    end_time_ms?: number;
}
/**
 * 追踪日志接口响应
 */
export interface TraceLogResponse {
    success: boolean;
    message?: string;
    data?: any;
}
/**
 * 发送追踪日志
 * @param traceData 追踪日志数据
 * @returns 发送结果
 */
export declare function sendTraceLog(traceData: TraceLogRequest): Promise<TraceLogResponse>;
/**
 *
 * @param traceData 追踪日志数据
 * @param outputContent 可以使用自定义的输出内容
 * @returns 发送结果
 */
export declare function traceLog(traceData: TraceLogRequest, outputContent: TraceLogResponse): Promise<TraceLogResponse>;
