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
import { readFileSync, readdirSync, existsSync, mkdirSync, rmdirSync, statSync } from "fs"
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

// 跨进程串行化数据库“首次初始化”(设置 pragma + 跑 migration)。
// 同一个 opencode.db 会被多个 testagent 进程打开(编辑器扩展、编辑器侧 agent host、
// Agent 窗口 agent host)。若两个进程并发执行初始化(尤其 migration 与
// wal_checkpoint),会破坏 WAL,产生 "disk I/O error" 并损坏 DB。
// 用 mkdir 的原子性做互斥锁;超时/陈旧锁(>60s)可抢占。
function acquireInitLock(dbPath: string, timeoutMs = 30000): () => void {
  const lockDir = `${dbPath}.init.lock`
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(lockDir)
      return () => {
        try {
          rmdirSync(lockDir)
        } catch {
          /* already gone */
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        const stat = statSync(lockDir)
        if (Date.now() - stat.mtimeMs > 60_000) {
          rmdirSync(lockDir)
          continue
        }
      } catch {
        /* lock disappeared, retry */
      }
      if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for database init lock")
      sleepSync(200)
    }
  }
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
  // 用跨进程锁把“首次初始化”(pragma + migration)整体串行化,避免多进程并发初始化
  // 破坏 WAL(详见 acquireInitLock 注释)。busy_timeout 必须先于 journal_mode=WAL 设置。
  const releaseInitLock = acquireInitLock(Path)
  try {
    db.run("PRAGMA busy_timeout = 15000")
    withRetry(() => db.run("PRAGMA journal_mode = WAL"))
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA cache_size = -64000")
    db.run("PRAGMA foreign_keys = ON")
    // 不再在打开时执行 `PRAGMA wal_checkpoint(PASSIVE)`:多进程并发 checkpoint 会与其他
    // 进程的写入/迁移竞争并失败/损坏 DB("disk I/O error"),交给 SQLite 自动 checkpoint。

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
  } finally {
    releaseInitLock()
  }
  // testagent-core_change end

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
