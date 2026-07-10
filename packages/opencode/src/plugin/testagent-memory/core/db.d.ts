/**
 * MemExtractHisRecord type - 记忆提取历史记录
 */
export type MemExtractHisRecord = {
    part_id: string;
    session_id: string;
    message_id: string;
    project_id: string;
    content?: string | null;
    role?: string | null;
    status: number;
    time_created: number;
    time_updated: number;
};
/**
 * SQLite database manager class with complete CRUD operations
 */
export declare class DatabaseManager {
    private db;
    private dbPath;
    constructor(dbPath?: string);
    /**
     * Initialize database connection
     * Opens or creates the database file
     * Creates required tables if database file does not exist
     */
    initialize(): Promise<void>;
    /**
     * Close database connection
     */
    close(): void;
    /**
     * Create mem_extract_his table for memory extraction history records
     * 记忆提取历史表
     *
     * @param ifNotExists Whether to add IF NOT EXISTS clause (default: true)
     * @returns True if table created successfully
     */
    createMemExtractHisTable(ifNotExists?: boolean): boolean;
    /**
     * Query all records by project_id with optional status filter
     * 根据项目ID查询所有记录，可选按status过滤
     *
     * @param projectId The project ID to query
     * @param status Optional status filter. If null or undefined, returns all records regardless of status
     * @returns Array of memory extract history records matching the criteria
     */
    queryByProjectId(projectId: string, status?: number | null): Promise<MemExtractHisRecord[]>;
    /**
     * Insert or update a mem_extract_his record.
     * If a record with the same part_id already exists, it will be updated;
     * otherwise, a new record will be inserted.
     *
     * @param record The memory extract history record to insert or update
     * @returns The part_id of the upserted record
     */
    upsertMemExtractHis(record: MemExtractHisRecord): Promise<string>;
    /**
     * Query pending records by project_id and session_id (status = 0)
     * 根据项目ID和会话ID查询待处理的记录（status=0）
     *
     * @param projectId The project ID to query
     * @param sessionId The session ID to filter (optional)
     * @returns Array of pending memory extract history records
     */
    queryPendingByProjectId(projectId: string, sessionId?: string): Promise<MemExtractHisRecord[]>;
    /**
     * Update status for multiple records by part_ids
     * 批量更新记录状态
     *
     * @param partIds Array of part_id to update
     * @param status New status value (default: 1 for processed)
     * @returns Number of records updated
     */
    updateStatusByPartIds(partIds: string[], status?: number): Promise<number>;
}
/**
 * Get the database singleton instance
 * @param dbPath Optional database path (only used on first call)
 * @returns Database manager instance
 */
export declare function getDatabase(dbPath?: string): Promise<DatabaseManager>;
/**
 * Close and reset the database singleton
 */
export declare function closeDatabase(): void;
export default DatabaseManager;
