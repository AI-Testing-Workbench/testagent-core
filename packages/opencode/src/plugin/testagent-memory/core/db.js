/**
 * SQLite database access module for OpenCode memory system.
 * Provides complete CRUD operations using node:sqlite (built-in Node.js SQLite support).
 *
 * @date 2026-07-03 09:53:00
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
/**
 * Get the default database path in current user's home directory
 * @returns Database path
 */
function getDefaultDbPath() {
    return join(homedir(), '.local', 'share', 'testagent', "memory", 'memory.db');
}
/**
 * Database configuration
 */
const DB_PATH = getDefaultDbPath();
/**
 * SQLite database manager class with complete CRUD operations
 */
export class DatabaseManager {
    db = null;
    dbPath;
    constructor(dbPath = DB_PATH) {
        this.dbPath = dbPath;
    }
    /**
     * Initialize database connection
     * Opens or creates the database file
     * Creates required tables if database file does not exist
     */
    async initialize() {
        const dbDir = dirname(this.dbPath);
        const dbFileExists = existsSync(this.dbPath);
        // Ensure directory exists
        if (!existsSync(dbDir)) {
            mkdirSync(dbDir, { recursive: true });
        }
        // Open database (creates if not exists)
        this.db = new DatabaseSync(this.dbPath);
        // Enable foreign keys and WAL mode for better performance
        this.db.exec('PRAGMA foreign_keys = ON');
        this.db.exec('PRAGMA journal_mode = WAL');
        // If database file did not exist, create required tables
        if (!dbFileExists) {
            this.createMemExtractHisTable(true);
        }
    }
    /**
     * Close database connection
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
    /**
     * Create mem_extract_his table for memory extraction history records
     * 记忆提取历史表
     *
     * @param ifNotExists Whether to add IF NOT EXISTS clause (default: true)
     * @returns True if table created successfully
     */
    createMemExtractHisTable(ifNotExists = true) {
        if (!this.db) {
            throw new Error('Database not initialized');
        }
        let sql = 'CREATE TABLE';
        if (ifNotExists) {
            sql += ' IF NOT EXISTS';
        }
        sql += ' mem_extract_his(\n' +
            '      part_id TEXT NOT NULL,\n' +
            '      session_id TEXT NOT NULL,\n' +
            '      message_id TEXT NOT NULL,\n' +
            '      project_id TEXT NOT NULL,\n' +
            '      content TEXT,\n' +
            '      role TEXT,\n' +
            '      status INTEGER NOT NULL DEFAULT 0,\n' +
            '      time_created INTEGER NOT NULL,\n' +
            '      time_updated INTEGER NOT NULL,\n' +
            '      PRIMARY KEY (part_id)\n' +
            '    )';
        this.db.exec(sql);
        return true;
    }
    /**
     * Query all records by project_id with optional status filter
     * 根据项目ID查询所有记录，可选按status过滤
     *
     * @param projectId The project ID to query
     * @param status Optional status filter. If null or undefined, returns all records regardless of status
     * @returns Array of memory extract history records matching the criteria
     */
    async queryByProjectId(projectId, status) {
        if (!this.db) {
            throw new Error('Database not initialized');
        }
        let sql = 'SELECT part_id, session_id, message_id, project_id, content, role, status, time_created, time_updated FROM mem_extract_his WHERE project_id = ?';
        const params = [projectId];
        if (status !== null && status !== undefined) {
            sql += ' AND status = ?';
            params.push(status);
        }
        const stmt = this.db.prepare(sql);
        const results = stmt.all(...params);
        return results.map(row => ({
            part_id: row.part_id,
            session_id: row.session_id,
            message_id: row.message_id,
            project_id: row.project_id,
            content: row.content,
            role: row.role,
            status: row.status,
            time_created: row.time_created,
            time_updated: row.time_updated
        }));
    }
    /**
     * Insert or update a mem_extract_his record.
     * If a record with the same part_id already exists, it will be updated;
     * otherwise, a new record will be inserted.
     *
     * @param record The memory extract history record to insert or update
     * @returns The part_id of the upserted record
     */
    async upsertMemExtractHis(record) {
        if (!this.db) {
            throw new Error('Database not initialized');
        }
        const sql = `INSERT INTO mem_extract_his (part_id, session_id, message_id, project_id, content, role, status, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(part_id) DO UPDATE SET
        session_id   = excluded.session_id,
        message_id   = excluded.message_id,
        project_id   = excluded.project_id,
        content      = excluded.content,
        role         = excluded.role,
        status       = excluded.status,
        time_created = excluded.time_created,
        time_updated = excluded.time_updated`;
        const stmt = this.db.prepare(sql);
        stmt.run(record.part_id, record.session_id, record.message_id, record.project_id, record.content ?? null, record.role ?? null, record.status, record.time_created, record.time_updated);
        return record.part_id;
    }
    /**
     * Query pending records by project_id and session_id (status = 0)
     * 根据项目ID和会话ID查询待处理的记录（status=0）
     *
     * @param projectId The project ID to query
     * @param sessionId The session ID to filter (optional)
     * @returns Array of pending memory extract history records
     */
    async queryPendingByProjectId(projectId, sessionId) {
        if (!this.db) {
            throw new Error('Database not initialized');
        }
        let sql = 'SELECT part_id, session_id, message_id, project_id, content, role, status, time_created, time_updated FROM mem_extract_his WHERE project_id = ? AND status = 0';
        const params = [projectId];
        if (sessionId) {
            sql += ' AND session_id = ?';
            params.push(sessionId);
        }
        sql += ' ORDER BY time_created ASC';
        const stmt = this.db.prepare(sql);
        const results = stmt.all(...params);
        return results.map(row => ({
            part_id: row.part_id,
            session_id: row.session_id,
            message_id: row.message_id,
            project_id: row.project_id,
            content: row.content,
            role: row.role,
            status: row.status,
            time_created: row.time_created,
            time_updated: row.time_updated
        }));
    }
    /**
     * Update status for multiple records by part_ids
     * 批量更新记录状态
     *
     * @param partIds Array of part_id to update
     * @param status New status value (default: 1 for processed)
     * @returns Number of records updated
     */
    async updateStatusByPartIds(partIds, status = 1) {
        if (!this.db) {
            throw new Error('Database not initialized');
        }
        if (partIds.length === 0) {
            return 0;
        }
        const placeholders = partIds.map(() => '?').join(', ');
        const sql = `UPDATE mem_extract_his SET status = ?, time_updated = ? WHERE part_id IN (${placeholders})`;
        const stmt = this.db.prepare(sql);
        const result = stmt.run(status, Date.now(), ...partIds);
        return Number(result.changes);
    }
}
// ---------------------------------------------------------------------------
// Singleton instance for convenience
// ---------------------------------------------------------------------------
let dbInstance = null;
/**
 * Get the database singleton instance
 * @param dbPath Optional database path (only used on first call)
 * @returns Database manager instance
 */
export async function getDatabase(dbPath) {
    if (!dbInstance) {
        dbInstance = new DatabaseManager(dbPath);
        await dbInstance.initialize();
    }
    return dbInstance;
}
/**
 * Close and reset the database singleton
 */
export function closeDatabase() {
    if (dbInstance) {
        dbInstance.close();
        dbInstance = null;
    }
}
export default DatabaseManager;
