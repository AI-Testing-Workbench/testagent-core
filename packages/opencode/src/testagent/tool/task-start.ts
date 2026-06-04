import { readFile } from "fs/promises"
import { homedir } from "os"
import { join } from "path"
import { Effect, Schema } from "effect"
import { Git } from "@/git"
import { InstanceState } from "@/effect/instance-state"
import * as Tool from "../../tool/tool"
import * as Task from "./task-common"

const DEFAULT_CREATOR = "自动化测试室/80278297"
const PROFILE = join(homedir(), ".local", "share", "testagent", "external-user.json")

const Parameters = Schema.Struct({
  selectCasesList: Schema.Array(Schema.String).annotate({ description: "用户选中/勾选的案例或目录" }),
  projectPhaseRound: Schema.String.annotate({ description: "项目阶段轮次" }),
  roundId: Schema.Number.annotate({ description: "轮次id" }),
  phaseId: Schema.Number.annotate({ description: "阶段id" }),
})

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

function user() {
  return Effect.gen(function* () {
    const content = yield* Effect.tryPromise({
      try: () => readFile(PROFILE, "utf-8"),
      catch: (err) => new Error(`读取用户配置文件失败: ${err instanceof Error ? err.message : String(err)}`),
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))

    if (!content) return DEFAULT_CREATOR

    const data = yield* Effect.try({
      try: () => JSON.parse(content) as unknown,
      catch: () => new Error("解析用户配置文件失败"),
    }).pipe(Effect.catch(() => Effect.succeed({})))
    const item = record(data)
    const name = text(item?.userName)
    const id = text(item?.userId)
    if (name && id) return `${name}/${id}`
    return DEFAULT_CREATOR
  })
}

function gitInfo(worktree: string, git: Git.Interface) {
  return Effect.gen(function* () {
    const branch = yield* git.run(["symbolic-ref", "--short", "HEAD"], { cwd: worktree }).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.text().trim() : "")),
      Effect.catch(() => Effect.succeed("")),
    )
    const remote = yield* git.run(["remote", "get-url", "origin"], { cwd: worktree }).pipe(
      Effect.map((result) =>
        result.exitCode === 0
          ? result.text().trim().replace("git@gitee.itc.cmbchina.cn:", "https://gitee.paas.cmbchina.cn/")
          : "",
      ),
      Effect.catch(() => Effect.succeed("")),
    )
    return { branch, remote }
  })
}

function fail(message: string, cases?: number): Tool.ExecuteResult<Task.StartMetadata> {
  return {
    title: "Task Start Failed",
    output: Task.output({ success: false, errorMsg: message }),
    metadata: { success: false, cases },
  }
}

export const TaskStartTool = Tool.define<typeof Parameters, Task.StartMetadata, Git.Service>(
  "task-start",
  Effect.gen(function* () {
    const git = yield* Git.Service

    return {
      description:
        "根据用户选中/勾选案例、阶段轮次、轮次ID、阶段ID信息，发起项目内跑批执行任务。并通过任务ID查看最新的执行情况。",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Task.StartMetadata>) =>
        Effect.gen(function* () {
          const cases = params.selectCasesList.length
          const source = params.projectPhaseRound.trim()

          if (cases === 0) return fail("没有勾选案例", cases)
          if (!source) return fail("没有关联项目信息", cases)
          if (!Number.isFinite(params.roundId) || params.roundId <= 0) return fail("没有关联轮次信息", cases)
          if (!Number.isFinite(params.phaseId) || params.phaseId <= 0) return fail("没有关联阶段信息", cases)

          const instance = yield* InstanceState.context
          const current = yield* user()
          const info = yield* gitInfo(instance.worktree, git)

          if (!info.remote) return fail("未获取到远程仓库地址、分支信息，请关联远程仓库", cases)

          const created = yield* Task.create(
            {
              currentUserName: current,
              giteeAddress: info.remote,
              codeBranch: info.branch,
              selectPathList: params.selectCasesList,
              projectSource: source,
              roundId: params.roundId,
              phaseId: params.phaseId,
            },
            ctx.abort,
          )

          if (created.returnCode !== "SUC0000") {
            return fail(created.errorMsg || created.errMsg || "任务创建失败", cases)
          }

          const taskId = Task.taskID(created.body)
          if (!taskId) {
            return {
              title: "Task Started",
              output: Task.output({
                success: true,
                errorMsg: "任务创建成功，请稍后通过任务ID查询任务详情",
                taskId: created.body,
              }),
              metadata: { success: true, cases },
            }
          }

          return yield* Effect.gen(function* () {
            yield* Effect.sleep(2_000)
            const detail = yield* Task.query([Number(taskId)], ctx.abort)
            const item = Task.first(detail)

            if (!item?.id) {
              return {
                title: "Task Started",
                output: Task.output({ success: false, error: `未找到任务ID为 ${taskId} 的任务详情` }),
                metadata: { success: false, taskId, cases },
              }
            }

            return {
              title: `Task ${taskId}`,
              output: Task.output(Task.format(taskId, item)),
              metadata: { success: true, taskId, cases },
            }
          }).pipe(
            Effect.catch(() =>
              Effect.succeed({
                title: "Task Started",
                output: Task.output({
                  success: true,
                  errorMsg: "任务发起成功，查询任务详情失败，请稍后再根据任务ID重试",
                  taskId,
                }),
                metadata: { success: true, taskId, cases },
              }),
            ),
          )
        }).pipe(
          Effect.catch((err) =>
            Effect.succeed({
              title: "Task Start Failed",
              output: Task.output({ success: false, errorMsg: err.message }),
              metadata: { success: false, cases: params.selectCasesList.length },
            }),
          ),
        ),
    }
  }),
)
