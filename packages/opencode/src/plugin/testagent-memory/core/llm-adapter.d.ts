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
import type { LLMClient } from "./types.js";
type Client = ReturnType<typeof createOpencodeClient>;
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
export declare function createOpenCodeLLMClient(client: Client, parentID: string): LLMClient;
export {};
