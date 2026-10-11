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

/**
 * States understood by the desktop pet (`DesktopPetState` in tscode).
 *
 * Deliberately small and identical to the Agent Host mode mapping so the pet
 * looks the same regardless of the consumer:
 *   - `working`      → thinking.svg     (turn/tool in progress; held)
 *   - `complete`     → attention.svg    (turn finished)
 *   - `notification` → notification.svg (permission asked / question asked)
 *   - `idle`         → reset to the self-running idle lifecycle
 */
export type PetState = "idle" | "working" | "complete" | "notification"

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
    case "session.status": {
      // Busy covers reasoning + response + tool use.
      const status = props.status
      const type = typeof status === "object" && status !== null ? (status as { type?: unknown }).type : undefined
      if (type === "busy") return { state: "working", sessionID }
      return undefined
    }
    case "message.part.updated": {
      const part = props.part
      if (typeof part !== "object" || part === null) return undefined
      const type = (part as { type?: unknown }).type
      // Reasoning / assistant text / compaction → working.
      if (type === "reasoning" || type === "text" || type === "compaction") {
        return { state: "working", sessionID }
      }
      if (type === "tool") {
        const state = (part as { state?: unknown }).state
        const status =
          typeof state === "object" && state !== null ? (state as { status?: unknown }).status : undefined
        if (status === "running" || status === "completed") return { state: "working", sessionID }
      }
      return undefined
    }
    case "session.compacted":
      return { state: "working", sessionID }
    case "permission.asked":
    case "question.asked":
      // Held until the user responds (notification is a sticky state).
      return { state: "notification", sessionID }
    case "permission.replied":
    case "question.replied":
    case "question.rejected":
      // The user responded; the agent resumes working.
      return { state: "working", sessionID }
    case "session.idle":
      // Turn finished → complete. An explicit user abort just resets to idle.
      if (props.reason === "user_abort") return { state: "idle", sessionID }
      return { state: "complete", sessionID }
    case "session.error":
      // No dedicated error state; just stop the busy pose.
      return { state: "idle", sessionID }
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

  // Sessions currently blocked on the user (permission / question). While a
  // session is in this set, `working` updates are suppressed so the sticky
  // notification state is held until the user answers. This mirrors the Agent
  // Host side, which suppresses working while `SessionInputNeeded*` is
  // outstanding. Without it, the question tool's own `session.status`/tool-part
  // updates arrive right after `question.asked` and immediately override the
  // notification pose.
  const waiting = new Set<string>()

  return {
    async event({ event }) {
      const e = event as BusEvent
      const translated = translateEvent(e)
      if (!translated) return
      const sid = translated.sessionID ?? ""

      switch (e.type) {
        case "permission.asked":
        case "question.asked":
          if (sid) waiting.add(sid)
          emit(translated.state, e, translated.sessionID)
          return
        case "permission.replied":
        case "question.replied":
        case "question.rejected":
          waiting.delete(sid)
          emit(translated.state, e, translated.sessionID)
          return
        default:
          break
      }

      // Suppress busy updates while the session is waiting for the user.
      if (translated.state === "working" && sid && waiting.has(sid)) {
        return
      }
      if (translated.state === "complete" || translated.state === "idle") {
        waiting.delete(sid)
      }
      emit(translated.state, e, translated.sessionID)
    },
  }
}
