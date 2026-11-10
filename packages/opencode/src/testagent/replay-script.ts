import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "replay.script" })

export type Step = {
  text?: string
  reasoning?: string
  tools: Array<{ tool: string; callID: string; input: { [key: string]: unknown } }>
  reason?: string
}

type Opts = { small?: boolean; agent?: string }

const store = new Map<string, { rest: Step[] }>()
const STOP: Step = { tools: [], reason: "stop" }

function skip(opts?: Opts) {
  if (!opts) return false
  if (opts.small) return true
  if (opts.agent === "title" || opts.agent === "compaction") return true
  return false
}

export function arm(id: string, step: Step | readonly Step[]) {
  const rest = Array.isArray(step) ? [...(step as Step[])] : [step]
  store.set(id, { rest })
  log.info("arm", { sessionID: id, steps: rest.length })
}

export function live(id: string) {
  return store.has(id)
}

export function spent(id: string) {
  return store.get(id)?.rest.length === 0
}

export function pending(id: string) {
  return (store.get(id)?.rest.length ?? 0) > 0
}

export function clear(id: string) {
  store.delete(id)
}

export function reset() {
  store.clear()
}

export function pull(id: string, opts?: Opts): Step | undefined {
  if (skip(opts)) return
  const item = store.get(id)
  if (!item) return
  if (item.rest.length === 0) {
    log.info("pull spent", { sessionID: id })
    return STOP
  }
  const [head, ...tail] = item.rest
  store.set(id, { rest: tail })
  log.info("pull", { sessionID: id, tools: head.tools.length, left: tail.length })
  return head
}

export * as ReplayScript from "./replay-script"
