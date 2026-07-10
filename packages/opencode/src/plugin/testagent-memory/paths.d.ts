export declare const ENTRYPOINT_NAME = "MEMORY.md";
export declare const PERSONA_NAME = "PERSONA.md";
export declare const MAX_ENTRYPOINT_LINES = 200;
export declare const MAX_ENTRYPOINT_BYTES = 25000;
export declare const MAX_MEMORY_FILES = 200;
export declare const MAX_MEMORY_FILE_BYTES = 40000;
export declare const FRONTMATTER_MAX_LINES = 30;
export declare function validateMemoryFileName(fileName: string): string;
export declare function sanitizePath(name: string): string;
export declare function findCanonicalGitRoot(startPath: string): string | null;
export declare function getProjectDir(worktree: string): string;
export declare function getMemoryDir(worktree: string): string;
export declare function getTeamMemoryDir(worktree: string): string;
export declare function getTeamMemoryEntrypoint(worktree: string): string;
export declare function getMemoryEntrypoint(worktree: string): string;
export declare function isMemoryPath(absolutePath: string, worktree: string): boolean;
export declare function ensureDir(dir: string): void;
export declare function getOpencodeConfigHomeDir(): string;
export declare function getOpencodeConfigCommands(): string;
/**
 * 个人全局记忆文件
 * @returns
 */
export declare function getPersonalMemoryFile(): string;
/**
 * 个人全局记忆文件-备份
 * @returns
 */
export declare function getPersonalMemoryFileBackup(): string;
/**
 * 个人全局记忆备份目录（轮转保留最近10个）
 * @returns
 */
export declare function getPersonalMemoryBackupDir(): string;
