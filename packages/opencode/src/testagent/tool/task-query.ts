import { Effect, Schema } from "effect"
import * as Tool from "../../tool/tool"
import * as Task from "./task-common"

const Parameters = Schema.Struct({
  taskId: Schema.String.annotate({ description: "任务ID，必填" }),
})

export const TaskQueryTool = Tool.define<typeof Parameters, Task.QueryMetadata, never>(
  "task-query",
  Effect.gen(function* () {
    return {
      description: "根据任务ID查询项目内任务的详细信息或执行结果信息（任务类型固定为4-高码案例执行集任务）",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Task.QueryMetadata>) =>
        Effect.gen(function* () {
          const taskId = params.taskId.trim()
          const id = Number(taskId)

          if (!taskId || !Number.isFinite(id)) {
            return {
              title: "Task Query Failed",
              output: Task.output({ success: false, error: "缺少或非法的必填参数：任务ID" }),
              metadata: { success: false },
            }
          }

          const result = yield* Task.query([id], ctx.abort)
          const detail = Task.first(result)

          if (!detail?.id) {
            return {
              title: "Task Not Found",
              output: Task.output({ success: false, error: `未找到任务ID为 ${taskId} 的任务详情` }),
              metadata: { success: false, taskId },
            }
          }

          return {
            title: `Task ${taskId}`,
            output: Task.output(Task.format(taskId, detail)),
            metadata: { success: true, taskId },
          }
        }).pipe(
          Effect.catch((err) =>
            Effect.succeed({
              title: "Task Query Failed",
              output: Task.output({ success: false, error: err.message }),
              metadata: { success: false },
            }),
          ),
        ),
    }
  }),
)
