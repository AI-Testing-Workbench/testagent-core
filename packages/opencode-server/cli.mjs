#!/usr/bin/env node --experimental-sqlite
import { parseArgs } from "node:util"
import { Server, Log } from "./node.js"

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4096" },
    hostname: { type: "string", default: "0.0.0.0" },
    password: { type: "string" },
    username: { type: "string", default: "opencode" },
  },
})

if (values.password) {
  process.env.OPENCODE_SERVER_PASSWORD = values.password
  process.env.OPENCODE_SERVER_USERNAME = values.username
}

await Log.init({ level: "INFO" })
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
