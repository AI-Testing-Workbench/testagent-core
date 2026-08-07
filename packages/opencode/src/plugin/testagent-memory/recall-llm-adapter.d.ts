/**
 * OpenCode LLMClient adapter.
 *
 * Wraps the OpenCode SDK's `client.session.prompt()` into the host-agnostic
 * `LLMClient` interface that @loreai/core expects. Handles:
 *   1. Worker session lifecycle (create → prompt → rotate)
 *   2. "Agent not found" retry (OpenCode loses plugin agent registrations
 *      after a config re-read) — retries once without the agent parameter
 *   3. Error extraction from SDK response objects
 *
 * This is the OpenCode-specific counterpart of what `promptWorker()` used to
 * do in core's worker.ts, but now lives in the host adapter layer.
 */
import type { createOpencodeClient } from "@opencode-ai/sdk";
type Client = ReturnType<typeof createOpencodeClient>;
/**
 * Abstract interface for single-turn LLM prompt→response.
 *
 * All of Lore's background LLM work (distillation, curation, query expansion)
 * is single-turn: one system+user message in, one text response out. No tool
 * calling, no multi-turn. This interface captures that minimal surface.
 *
 * Host adapters implement this:
 * - OpenCode: wraps `client.session.create()` + `client.session.prompt()`
 * - Pi: wraps `complete()` from `@mariozechner/pi-ai`
 * - Standalone: direct `fetch()` to provider APIs
 */
export interface LLMClient {
    /**
     * Send a single prompt and return the text response.
     *
     * @param system  System prompt text
     * @param user    User message text
     * @param opts    Optional model selection and worker identification
     * @returns The assistant's text response, or null on failure
     */
    prompt(system: string, user: string, opts?: {
        /** Override model for this call. */
        model?: {
            providerID: string;
            modelID: string;
        };
        /**
         * Opaque worker identifier used by the host to route the request
         * (e.g. OpenCode uses this as the session agent name).
         */
        workerID?: string;
        sessionID: string;
        partId: string;
        messageId: string;
    }): Promise<string | null>;
}
/**
 * Create an LLMClient backed by the OpenCode SDK.
 *
 * Each call to `prompt()` creates a fresh hidden child session, sends the
 * prompt, extracts the text, and discards the session (rotation). This
 * prevents accumulating multiple assistant messages with reasoning/thinking
 * parts, which providers reject.
 *
 * @param client     The OpenCode SDK client
 * @param parentID   Parent session ID — child sessions are created under this
 */
export declare function createOpenCodeRecallLLMClient(client: Client, parentID: string, opts?: {
    /** Override model for this call. */
    model?: {
        providerID: string;
        modelID: string;
    };
    /**
     * Opaque worker identifier used by the host to route the request
     * (e.g. OpenCode uses this as the session agent name).
     */
    workerID?: string;
    sessionID: string;
    partId: string;
    messageId: string;
}): LLMClient;
export {};
