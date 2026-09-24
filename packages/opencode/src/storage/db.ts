import { type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { LocalContext } from "@/util/local-context"
import { lazy } from "../util/lazy"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { NamedError } from "@opencode-ai/core/util/error"
import z from "zod"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import { Flag } from "@opencode-ai/core/flag/flag"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { InstanceState } from "@/effect/instance-state"
import { iife } from "@/util/iife"
import { init } from "#db"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export function getChannelPath() {
  if (["latest", "beta", "prod"].includes(InstallationChannel) || Flag.OPENCODE_DISABLE_CHANNEL_DB)
    return path.join(Global.Path.data, "opencode.db")
  const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
  return path.join(Global.Path.data, `opencode-${safe}.db`)
}

export const Path = iife(() => {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || path.isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return path.join(Global.Path.data, Flag.OPENCODE_DB)
  }
  return getChannelPath()
})

export type Transaction = SQLiteTransaction<"sync", void>

type Client = SQLiteBunDatabase

type Journal = { sql: string; timestamp: number; name: string }[]

// Drizzle's migrate overloads trigger expensive variance checks here; narrow to the journal overload we actually use.
const migrateFromJournal = migrate as unknown as (db: SQLiteBunDatabase, entries: Journal) => void

function applyMigrations(db: SQLiteBunDatabase, entries: Journal) {
  migrateFromJournal(db, entries)
}

function time(tag: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
  if (!match) return 0
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
}

// testagent-core_change start
// 同步睡眠:用于锁竞争重试(Bun/Node 通用,不依赖异步 sleep)。
function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// 小步重试:配合 busy_timeout,抵御多进程打开同一 DB 时的瞬时锁竞争。
function withRetry<T>(fn: () => T, attempts = 8, delayMs = 250): T {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return fn()
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) sleepSync(delayMs)
    }
  }
  throw lastError
}
// testagent-core_change end

function migrations(dir: string): Journal {
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  const sql = dirs
    .map((name) => {
      const file = path.join(dir, name, "migration.sql")
      if (!existsSync(file)) return
      return {
        sql: readFileSync(file, "utf-8"),
        timestamp: time(name),
        name,
      }
    })
    .filter(Boolean) as Journal

  return sql.sort((a, b) => a.timestamp - b.timestamp)
}

export const Client = lazy(() => {
  log.info("opening database", { path: Path })

  const db = init(Path)

  // testagent-core_change start
  // busy_timeout 必须在 journal_mode=WAL 之前设置。
  // 同一个 opencode.db 会被多个进程同时打开(编辑器扩展、编辑器侧的 agent host、
  // 以及 Agent 窗口的 agent host 各自拉起一个 testagent)。node:sqlite 的默认 busy
  // timeout 为 0,若先执行 `PRAGMA journal_mode = WAL`,第二个进程拿不到切换 WAL 所需
  // 的排他锁会立即返回 SQLITE_BUSY(node:sqlite 表现为 "disk I/O error"),
  // 进而导致 /provider、/session/ 返回 500、模型与会话列表为空。
  db.run("PRAGMA busy_timeout = 15000")
  withRetry(() => db.run("PRAGMA journal_mode = WAL"))
  // testagent-core_change end
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA cache_size = -64000")
  db.run("PRAGMA foreign_keys = ON")
  db.run("PRAGMA wal_checkpoint(PASSIVE)")

  // Apply schema migrations
  const entries =
    typeof OPENCODE_MIGRATIONS !== "undefined"
      ? OPENCODE_MIGRATIONS
      : migrations(path.join(import.meta.dirname, "../../migration"))
  if (entries.length > 0) {
    log.info("applying migrations", {
      count: entries.length,
      mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
    })
    if (Flag.OPENCODE_SKIP_MIGRATIONS) {
      for (const item of entries) {
        item.sql = "select 1;"
      }
    }
    applyMigrations(db, entries)
  }

  return db
})

export function close() {
  if (!Client.loaded()) return
  Client().$client.close()
  Client.reset()
}

export type TxOrDb = Transaction | Client

const ctx = LocalContext.create<{
  tx: TxOrDb
  effects: (() => void | Promise<void>)[]
}>("database")

export function use<T>(callback: (trx: TxOrDb) => T): T {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
      for (const effect of effects) effect()
      return result
    }
    throw err
  }
}

export function effect(fn: () => any | Promise<any>) {
  const bound = InstanceState.bind(fn)
  try {
    ctx.use().effects.push(bound)
  } catch {
    bound()
  }
}

type NotPromise<T> = T extends Promise<any> ? never : T

export function transaction<T>(
  callback: (tx: TxOrDb) => NotPromise<T>,
  options?: {
    behavior?: "deferred" | "immediate" | "exclusive"
  },
): NotPromise<T> {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const txCallback = InstanceState.bind((tx: TxOrDb) => ctx.provide({ tx, effects }, () => callback(tx)))
      const result = Client().transaction(txCallback, { behavior: options?.behavior })
      for (const effect of effects) effect()
      return result as NotPromise<T>
    }
    throw err
  }
}

export * as Database from "./db"
