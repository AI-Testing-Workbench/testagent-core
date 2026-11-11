import { Effect } from "effect"
import { Server } from "../../server/server"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import { notifyStartup } from "../../plugin/testagent-zh/index" // testagent_change

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    // testagent_change start - 沙箱启动通知在监听起来后立刻发：
    // 不再依赖首个带 ?directory= 的请求触发插件实例化（插件工厂里仍保留一次兜底调用）。
    // 扩展以工作区根目录为 cwd 派生 serve，process.cwd() 就是 Web UI 深链要用的那一段目录。
    notifyStartup({
      directory: process.cwd(),
      serverUrl: `http://${server.hostname}:${server.port}`,
    })
    // testagent_change end

    yield* Effect.never
  }),
})
