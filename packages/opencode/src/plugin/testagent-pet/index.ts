// testagent_change - new file
/**
 * TestAgent Pet plugin (built-in).
 *
 * Normalizes the per-session opencode bus events this process already receives
 * into a small, UI-oriented set of "pet states" and broadcasts them on the
 * process-wide GlobalBus as a custom event (`testagent.pet.state`).
 *
 * Why GlobalBus: `GlobalBus.emit("event", ...)` events are streamed verbatim on
 * the server's `GET /global/event` SSE endpoint (same mechanism as
 * `testagent.yolo.enabled` / `zh.answer.toggled`). Any client already connected
 * to that stream — the tscode agent host (Agents window) or the kilo VS Code
 * extension (editor plugin mode) — can pick the event up and relay it to the
 * local desktop pet. The plugin therefore does not know or care about the
 * consumer, and needs no extra port or discovery file.
 *
 * The pet's own "follow events" switch lives in the desktop app (context menu),
 * so this plugin always emits; the consumer decides whether to act on it.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { GlobalBus } from "@/bus/global"

export const PetStateEvent = "testagent.pet.state" as const

type Options = {
  enabled?: boolean
}

/** States understood by the desktop pet (`DesktopPetState` in tscode). */
export type PetState =
  | "idle"
  | "thinking"
  | "working"
  | "sweeping"
  | "attention"
  | "notification"
  | "error"
  | "sleeping"

type TranslateResult = {
  state: PetState
  sessionID: string | undefined
}

type BusEvent = {
  type?: string
  properties?: Record<string, unknown>
}

function sessionIDFromEvent(event: BusEvent): string | undefined {
  const props = event.properties
  const direct = props?.sessionID
  if (typeof direct === "string") return direct
  const info = props?.info
  if (typeof info === "object" && info !== null && typeof (info as { sessionID?: unknown }).sessionID === "string") {
    return (info as { sessionID: string }).sessionID
  }
  const part = props?.part
  if (typeof part === "object" && part !== null && typeof (part as { sessionID?: unknown }).sessionID === "string") {
    return (part as { sessionID: string }).sessionID
  }
  return undefined
}

/** Maps an opencode bus event to a pet state, or `undefined` when not relevant. */
export function translateEvent(event: BusEvent): TranslateResult | undefined {
  const props = event.properties ?? {}
  const sessionID = sessionIDFromEvent(event)

  switch (event.type) {
    case "session.created":
      return { state: "idle", sessionID }
    case "session.status": {
      const status = props.status
      const type = typeof status === "object" && status !== null ? (status as { type?: unknown }).type : undefined
      if (type === "busy") return { state: "thinking", sessionID }
      return undefined
    }
    case "message.part.updated": {
      const part = props.part
      if (typeof part !== "object" || part === null) return undefined
      const type = (part as { type?: unknown }).type
      if (type === "compaction") return { state: "sweeping", sessionID }
      if (type === "tool") {
        const state = (part as { state?: unknown }).state
        const status =
          typeof state === "object" && state !== null ? (state as { status?: unknown }).status : undefined
        if (status === "running" || status === "completed") return { state: "working", sessionID }
        if (status === "error") return { state: "error", sessionID }
      }
      return undefined
    }
    case "session.compacted":
      return { state: "sweeping", sessionID }
    case "permission.asked":
    case "question.asked":
      return { state: "notification", sessionID }
    case "session.error":
      return { state: "error", sessionID }
    case "session.idle":
      // Reason "user_abort" is a cancellation, not a finished turn.
      if (props.reason === "user_abort") return { state: "idle", sessionID }
      return { state: "attention", sessionID }
    case "session.deleted":
      return { state: "sleeping", sessionID }
    default:
      return undefined
  }
}

function emit(state: PetState, event: BusEvent, sessionID: string | undefined): void {
  GlobalBus.emit("event", {
    payload: {
      type: PetStateEvent,
      properties: {
        state,
        event: event.type,
        sessionID: sessionID ? `testagent:${sessionID}` : undefined,
      },
    },
  })
}

export const PetPlugin: Plugin = async (_input, options?: Options) => {
  if (options?.enabled === false) {
    return {}
  }

  return {
    async event({ event }) {
      const translated = translateEvent(event as BusEvent)
      if (!translated) return
      emit(translated.state, event as BusEvent, translated.sessionID)
    },
  }
}
