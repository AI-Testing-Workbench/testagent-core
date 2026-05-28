export type LogEntry = {
    timestamp: string;
    sessionId: string;
    content: string;
};
export type LoggerOptions = {
    logDir?: string;
};
export declare function appendLog(baseDir: string, sessionId: string, content: string, options?: LoggerOptions): string;
export declare function listLogFiles(baseDir: string, customDir?: string): string[];
export declare function readLogFile(baseDir: string, fileName: string, customDir?: string): string | null;
