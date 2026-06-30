import { readFileSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type GoalStatus = "active" | "paused" | "budgetLimited" | "complete" | "unmet"
export type MutableGoalStatus = "active" | "paused"

export type Goal = {
  sessionID: string
  objective: string
  status: GoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
  completionEvidence?: string | null
  blocker?: string | null
  closedAt?: number | null
  lastAccountedAt: number | null
  autoTurns: number
  lastContinuationAt: number | null
  continuationFailures: number
  lastStatus: string | null
}

type State = {
  version: 1
  goals: Record<string, Goal>
}

export type GoalSnapshot = Omit<Goal, "lastAccountedAt" | "autoTurns" | "lastContinuationAt"> & {
  remainingTokens: number | null
  sampledAt: number
  autoTurns: number
  lastContinuationAt: number | null
}

function defaultStateFile() {
  const dataHome =
    process.env.XDG_DATA_HOME ||
    (process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : join(homedir(), ".local", "share"))
  return join(dataHome, "testagent", "goals.json")
}

export function statePath() {
  return process.env.OPENCODE_GOAL_STATE_PATH || process.env.TESTAGENT_GOAL_STATE_PATH || defaultStateFile()
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function emptyState(): State {
  return { version: 1, goals: {} }
}

function isMissingStateFile(error: unknown) {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "paused" || value === "budgetLimited" || value === "complete" || value === "unmet"
}

function numberOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function nullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null
}

function decodeGoal(sessionID: string, value: unknown): Goal | undefined {
  if (!value || typeof value !== "object") return
  const goal = value as Record<string, unknown>
  const status = isGoalStatus(goal.status) ? goal.status : "active"
  const objective = typeof goal.objective === "string" ? goal.objective : ""
  if (!objective) return
  return {
    sessionID: typeof goal.sessionID === "string" ? goal.sessionID : sessionID,
    objective,
    status,
    tokenBudget: nullableNumber(goal.tokenBudget),
    tokensUsed: numberOr(goal.tokensUsed, 0),
    timeUsedSeconds: numberOr(goal.timeUsedSeconds, 0),
    createdAt: numberOr(goal.createdAt, nowSeconds()),
    updatedAt: numberOr(goal.updatedAt, nowSeconds()),
    completionEvidence: nullableString(goal.completionEvidence),
    blocker: nullableString(goal.blocker),
    closedAt: nullableNumber(goal.closedAt),
    lastAccountedAt: nullableNumber(goal.lastAccountedAt),
    autoTurns: numberOr(goal.autoTurns, 0),
    lastContinuationAt: nullableNumber(goal.lastContinuationAt),
    continuationFailures: numberOr(goal.continuationFailures, 0),
    lastStatus: nullableString(goal.lastStatus),
  }
}

function decodeState(value: unknown): State {
  if (!value || typeof value !== "object") return emptyState()
  const input = value as Record<string, unknown>
  if (!input.goals || typeof input.goals !== "object") return emptyState()
  return {
    version: 1,
    goals: Object.fromEntries(
      Object.entries(input.goals as Record<string, unknown>).flatMap(([sessionID, goal]) => {
        const decoded = decodeGoal(sessionID, goal)
        return decoded ? [[sessionID, decoded]] : []
      }),
    ),
  }
}

async function readState(): Promise<State> {
  try {
    return decodeState(JSON.parse(await readFile(statePath(), "utf8")) as unknown)
  } catch (error) {
    if (isMissingStateFile(error)) return emptyState()
    throw error
  }
}

function readStateSync(): State {
  try {
    return decodeState(JSON.parse(readFileSync(statePath(), "utf8")) as unknown)
  } catch (error) {
    if (isMissingStateFile(error)) return emptyState()
    throw error
  }
}

async function writeState(state: State) {
  const file = statePath()
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n")
  await rename(tmp, file)
}

let mutationQueue: Promise<void> = Promise.resolve()

function enqueueMutation<T>(operation: () => Promise<T>) {
  const current = mutationQueue.then(operation, operation)
  mutationQueue = current.then(
    () => undefined,
    () => undefined,
  )
  return current
}

async function mutate<T>(fn: (state: State) => T | Promise<T>) {
  return enqueueMutation(async () => {
    const state = await readState()
    const result = await fn(state)
    await writeState(state)
    return result
  })
}

export function validateObjective(objective: string) {
  const value = objective.trim()
  if (!value) throw new Error("goal objective must not be empty")
  if ([...value].length > 4000) throw new Error("goal objective must be at most 4000 characters")
  return value
}

export function validateEvidence(evidence: string | null | undefined, label: string) {
  const value = evidence?.trim()
  if (!value) throw new Error(`${label} must not be empty`)
  if ([...value].length > 4000) throw new Error(`${label} must be at most 4000 characters`)
  return value
}

function isClosed(status: GoalStatus) {
  return status === "complete" || status === "unmet"
}

function visibleStatus(status: GoalStatus): GoalStatus {
  return status === "budgetLimited" ? "active" : status
}

export function snapshot(goal: Goal): GoalSnapshot {
  const sampledAt = nowSeconds()
  const status = visibleStatus(goal.status)
  const activeSeconds =
    status === "active" && goal.lastAccountedAt != null ? Math.max(0, sampledAt - goal.lastAccountedAt) : 0
  const timeUsedSeconds = goal.timeUsedSeconds + activeSeconds
  return {
    sessionID: goal.sessionID,
    objective: goal.objective,
    status,
    tokenBudget: null,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    completionEvidence: goal.completionEvidence ?? null,
    blocker: goal.blocker ?? null,
    closedAt: goal.closedAt ?? null,
    continuationFailures: goal.continuationFailures,
    lastStatus: goal.lastStatus,
    autoTurns: goal.autoTurns,
    lastContinuationAt: goal.lastContinuationAt,
    remainingTokens: null,
    sampledAt,
  }
}

export async function getGoal(sessionID: string) {
  const state = await readState()
  const goal = state.goals[sessionID]
  return goal ? snapshot(goal) : null
}

export function getGoalSync(sessionID: string) {
  const state = readStateSync()
  const goal = state.goals[sessionID]
  return goal ? snapshot(goal) : null
}

export async function createGoal(sessionID: string, objective: string, _tokenBudget?: number | null) {
  const value = validateObjective(objective)
  return mutate((state) => {
    const existing = state.goals[sessionID]
    if (existing && !isClosed(existing.status)) {
      throw new Error("cannot create a new goal because this session already has a non-closed goal")
    }
    const now = nowSeconds()
    const goal: Goal = {
      sessionID,
      objective: value,
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
      completionEvidence: null,
      blocker: null,
      closedAt: null,
      lastAccountedAt: now,
      autoTurns: 0,
      lastContinuationAt: null,
      continuationFailures: 0,
      lastStatus: "Goal set.",
    }
    state.goals[sessionID] = goal
    return snapshot(goal)
  })
}

export async function setGoalStatus(sessionID: string, status: MutableGoalStatus) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) throw new Error("cannot update goal because this session has no goal")
    accountWallClock(goal)
    goal.status = status
    goal.updatedAt = nowSeconds()
    goal.lastAccountedAt = status === "active" ? goal.updatedAt : null
    goal.continuationFailures = status === "active" ? 0 : goal.continuationFailures
    goal.lastStatus = status === "active" ? "Goal resumed." : "Goal paused."
    return snapshot(goal)
  })
}

export async function closeGoal(
  sessionID: string,
  input:
    | {
        status: "complete"
        evidence: string
      }
    | {
        status: "unmet"
        blocker: string
      },
) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) throw new Error("cannot update goal because this session has no goal")
    accountWallClock(goal)
    const now = nowSeconds()
    goal.status = input.status
    goal.updatedAt = now
    goal.closedAt = now
    goal.lastAccountedAt = null
    if (input.status === "complete") {
      goal.completionEvidence = validateEvidence(input.evidence, "completion evidence")
      goal.blocker = null
    } else {
      goal.blocker = validateEvidence(input.blocker, "blocker")
      goal.completionEvidence = null
    }
    return snapshot(goal)
  })
}

export async function completeGoal(sessionID: string, evidence: string) {
  return closeGoal(sessionID, { status: "complete", evidence })
}

export async function markGoalUnmet(sessionID: string, blocker: string) {
  return closeGoal(sessionID, { status: "unmet", blocker })
}

export async function clearGoal(sessionID: string) {
  return mutate((state) => {
    const existed = Boolean(state.goals[sessionID])
    delete state.goals[sessionID]
    return existed
  })
}

export async function accountUsage(sessionID: string, tokensUsed?: number) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) return null
    if (goal.status === "budgetLimited") {
      goal.status = "active"
      goal.tokenBudget = null
      goal.lastAccountedAt = nowSeconds()
    }
    accountWallClock(goal)
    if (typeof tokensUsed === "number" && Number.isFinite(tokensUsed)) {
      goal.tokensUsed = Math.max(goal.tokensUsed, Math.max(0, Math.ceil(tokensUsed)))
    }
    goal.updatedAt = nowSeconds()
    return snapshot(goal)
  })
}

export async function reserveContinuation(sessionID: string, maxAutoTurns: number, minIntervalSeconds: number) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || (goal.status !== "active" && goal.status !== "budgetLimited")) return null
    const now = nowSeconds()
    if (goal.status === "budgetLimited") {
      goal.status = "active"
      goal.tokenBudget = null
      goal.lastAccountedAt = now
    }
    if (goal.autoTurns >= maxAutoTurns) return null
    if (goal.lastContinuationAt && now - goal.lastContinuationAt < minIntervalSeconds) return null
    accountWallClock(goal, now)
    goal.autoTurns += 1
    goal.lastContinuationAt = now
    goal.lastStatus = `Auto-continue ${goal.autoTurns} reserved.`
    goal.updatedAt = now
    return snapshot(goal)
  })
}

export async function recordContinuationResult(sessionID: string, result: "success" | "failure", maxFailures: number) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || goal.status !== "active") return goal ? snapshot(goal) : null
    const now = nowSeconds()
    goal.updatedAt = now
    if (result === "success") {
      goal.continuationFailures = 0
      goal.lastStatus = "Auto-continue prompt sent."
      return snapshot(goal)
    }
    goal.continuationFailures += 1
    goal.lastStatus = `Auto-continue failed ${goal.continuationFailures} time(s).`
    if (goal.continuationFailures >= maxFailures) {
      accountWallClock(goal, now)
      goal.status = "paused"
      goal.lastAccountedAt = null
      goal.lastStatus = `Paused after ${goal.continuationFailures} auto-continue failure(s).`
      goal.blocker = "Auto-continue prompt failed repeatedly. Resume the goal to retry."
    }
    return snapshot(goal)
  })
}

function accountWallClock(goal: Goal, now = nowSeconds()) {
  if (goal.status !== "active") return
  if (goal.lastAccountedAt == null) {
    goal.lastAccountedAt = now
    return
  }
  goal.timeUsedSeconds += Math.max(0, now - goal.lastAccountedAt)
  goal.lastAccountedAt = now
}

export function estimateTokensFromText(text: string) {
  return Math.ceil(text.length / 4)
}

export function formatGoal(goal: GoalSnapshot | null) {
  if (!goal) return "No goal is set for this session."
  const lines = [
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Time used: ${goal.timeUsedSeconds}s`,
    `Auto-continues: ${goal.autoTurns}`,
  ]
  if (goal.lastStatus) lines.push(`Last status: ${goal.lastStatus}`)
  if (goal.completionEvidence) lines.push(`Completion evidence: ${goal.completionEvidence}`)
  if (goal.blocker) lines.push(`Blocker: ${goal.blocker}`)
  return lines.join("\n")
}