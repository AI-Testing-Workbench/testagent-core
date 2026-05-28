/**
 * Host-agnostic message and part types for Lore's core memory engine.
 *
 * These replace the direct dependency on `@opencode-ai/sdk`'s `Message` and
 * `Part` types so the core can run under any host (OpenCode, Pi, future ACP
 * server, etc.). Each host adapter converts between its native types and these
 * Lore-internal types at the hook boundary.
 *
 * The type surface is intentionally minimal — only the fields that Lore's
 * runtime code actually reads/writes are included. Fields that only exist for
 * the host's UI or for features Lore doesn't touch are omitted.
 */
// Type guard helpers for narrowing LorePart in core logic.
export function isTextPart(p) {
    return p.type === "text";
}
export function isReasoningPart(p) {
    return p.type === "reasoning";
}
export function isToolPart(p) {
    return p.type === "tool";
}
