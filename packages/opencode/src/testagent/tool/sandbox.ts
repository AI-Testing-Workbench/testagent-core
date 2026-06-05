// testagent_change - new file
import { Effect, Schema } from "effect"
import * as Tool from "../../tool/tool"

const DESCRIPTION = `Create a sandbox environment and return VNC access link.

This tool sends a request to the sandbox service to create a new sandbox instance.
Returns a VNC URL that can be used to access the sandbox environment.`

const Parameters = Schema.Struct({
  host: Schema.String.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("99.11.9.162"))).annotate({
    description: "Sandbox host IP address",
  }),
  port: Schema.Number.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(3000))).annotate({
    description: "Sandbox port number",
  }),
})

type SandboxMetadata = {
  vnc_url: string | undefined
  host: string
  port: number
  success: boolean
  error?: string
}

export const SandboxTool = Tool.define(
  "sandbox",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          try {
            const response = yield* Effect.promise(() =>
              fetch(`${decodeURIComponent(atob("aHR0cCUzQSUyRiUyRmZhc3RhdXRvbWF0b3Itb3BlbmFwaS1ncm91cC5wYWFzLmNtYmNoaW5hLmNu"))}/sandbox-backend/sandbox`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  host: params.host,
                  port: params.port,
                }),
                signal: ctx.abort,
              }),
            )

            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`)
            }

            const result = (yield* Effect.promise(() => response.json())) as {
              returnCode: string
              data?: { vnc_url: string }
              errMsg?: string
            }

            if (result.returnCode === "SUC0000") {
              return {
                title: "Sandbox Created",
                output: `沙盒链接：${result.data?.vnc_url}`,
                metadata: {
                  vnc_url: result.data?.vnc_url,
                  host: params.host,
                  port: params.port,
                  success: true,
                } as SandboxMetadata,
              }
            }

            return {
              title: "Sandbox Creation Failed",
              output: result.errMsg || "创建沙盒失败",
              metadata: {
                vnc_url: undefined,
                host: params.host,
                port: params.port,
                success: false,
                error: result.errMsg,
              } as SandboxMetadata,
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return {
              title: "Request Failed",
              output: `请求失败：${message}`,
              metadata: {
                vnc_url: undefined,
                host: params.host,
                port: params.port,
                success: false,
                error: message,
              } as SandboxMetadata,
            }
          }
        }).pipe(Effect.orDie),
    }
  }),
)
