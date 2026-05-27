/** Set of ALL worker session IDs across distillation, curator, and query expansion.
 *  Used by shouldSkip() in index.ts to avoid storing/distilling worker messages. */
export declare const workerSessionIDs: Set<string>;
export declare function isWorkerSession(sessionID: string): boolean;
export declare function inferRoleFromPart(part: Record<string, unknown>): string;
