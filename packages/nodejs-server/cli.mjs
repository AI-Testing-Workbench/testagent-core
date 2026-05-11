#!/usr/bin/env node --experimental-sqlite
import { parseArgs } from "node:util"
import { Server, Log, Database, JsonMigration } from "./node.js"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4096" },
    hostname: { type: "string", default: "0.0.0.0" },
    password: { type: "string" },
    username: { type: "string", default: "opencode" },
  },
})

// Set environment variables
process.env.AGENT = "1"
process.env.OPENCODE = "1"
process.env.OPENCODE_PID = String(process.pid)

if (values.password) {
  process.env.OPENCODE_SERVER_PASSWORD = values.password
  process.env.OPENCODE_SERVER_USERNAME = values.username
}

await Log.init({ level: "INFO" })

// Database migration check
const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
const dataDir = join(xdgData, "testagent")
const marker = join(dataDir, "opencode.db")

if (!existsSync(marker)) {
  const isTTY = process.stderr.isTTY
  process.stderr.write("Performing one-time database migration, may take a few minutes...\n")
  
  const width = 36
  const orange = "\x1b[38;5;214m"
  const muted = "\x1b[0;2m"
  const reset = "\x1b[0m"
  let lastPercent = -1
  
  if (isTTY) process.stderr.write("\x1b[?25l") // Hide cursor
  
  try {
    const db = Database.Client()
    await JsonMigration.run(db, {
      progress: (event) => {
        const percent = Math.floor((event.current / event.total) * 100)
        if (percent === lastPercent && event.current !== event.total) return
        lastPercent = percent
        
        if (isTTY) {
          const fill = Math.round((percent / 100) * width)
          const bar = "■".repeat(fill) + "･".repeat(width - fill)
          process.stderr.write(
            `\r${orange}${bar} ${String(percent).padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`
          )
          if (event.current === event.total) process.stderr.write("\n")
        } else {
          process.stderr.write(`sqlite-migration:${percent}\n`)
        }
      },
    })
    
    // Create marker file to indicate migration is complete
    const { writeFileSync, mkdirSync } = await import("node:fs")
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(marker, "")
  } catch (err) {
    if (isTTY) process.stderr.write("\x1b[?25h") // Show cursor
    console.error("Database migration failed:", err)
    process.exit(1)
  } finally {
    if (isTTY) {
      process.stderr.write("\x1b[?25h") // Show cursor
    } else {
      process.stderr.write("sqlite-migration:done\n")
    }
  }
  
  process.stderr.write("Database migration complete.\n")
}

const server = await Server.listen({
  port: Number(values.port),
  hostname: values.hostname,
})
console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

const shutdown = async () => {
  await server.stop(true)
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
