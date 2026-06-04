import { Effect } from "effect"

const URL = "http://fastautomator-openapi-group.paas.cmbchina.cn"
const EXEC = `${URL}/mobile-execution`
const TYPE = 4

const status: Record<number, string> = {
  0: "等待执行",
  1: "正在执行",
  2: "执行成功",
  3: "执行失败",
  4: "取消执行",
}

const types: Record<number, string> = {
  0: "普通执行集任务",
  1: "普通执行集重跑任务",
  2: "并发执行集任务",
  4: "高码案例执行集任务",
}

export type Api = {
  returnCode?: string
  errorMsg?: string
  errMsg?: string
  data?: unknown
  body?: unknown
}

export type Detail = Record<string, unknown>

export type QueryMetadata = {
  success: boolean
  taskId?: string
}

export type StartMetadata = QueryMetadata & {
  cases?: number
}

export type Payload = {
  currentUserName: string
  giteeAddress: string
  codeBranch: string
  selectPathList: readonly string[]
  projectSource: string
  roundId: number
  phaseId: number
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const text = (value: unknown) => {
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  return undefined
}

const num = (item: Detail, key: string) => {
  const value = item[key]
  return typeof value === "number" ? value : undefined
}

const api = (value: unknown): Api => {
  const data = record(value)
  if (!data) throw new Error("接口响应不是对象")
  return {
    returnCode: text(data.returnCode),
    errorMsg: text(data.errorMsg),
    errMsg: text(data.errMsg),
    data: data.data,
    body: data.body,
  }
}

function signal(abort: AbortSignal) {
  return AbortSignal.any([abort, AbortSignal.timeout(30_000)])
}

function request(url: string, body: unknown, abort: AbortSignal) {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: signal(abort),
        }),
      catch: (err) => new Error(`HTTP请求失败: ${err instanceof Error ? err.message : String(err)}`),
    })

    if (!response.ok) return yield* Effect.fail(new Error(`HTTP ${response.status}: ${response.statusText}`))

    const raw = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (err) => new Error(`解析响应失败: ${err instanceof Error ? err.message : String(err)}`),
    })

    return api(raw)
  })
}

export function query(ids: number[], abort: AbortSignal) {
  return Effect.gen(function* () {
    const result = yield* request(`${EXEC}/exec/task/list?taskType=${TYPE}`, ids, abort)
    if (result.returnCode !== "SUC0000") {
      return yield* Effect.fail(new Error(result.errorMsg || result.errMsg || "查询任务详情失败"))
    }
    return result
  })
}

export function create(payload: Payload, abort: AbortSignal) {
  return request(`${URL}/mobile-execution/code-task/add`, payload, abort)
}

export function first(result: Api): Detail | undefined {
  if (!Array.isArray(result.data)) return undefined
  return record(result.data[0])
}

export function format(taskId: string, item: Detail) {
  const taskType = num(item, "taskType")
  const taskStatus = num(item, "status")
  return {
    success: true,
    message: "查询任务详情成功",
    data: {
      taskId,
      taskType: item.taskType,
      taskTypeDesc: taskType === undefined ? "未知" : (types[taskType] ?? "未知"),
      taskSource: item.taskSource,
      productCode: item.productCode,
      scriptGroupId: item.scriptGroupId,
      execSuiteName: item.name,
      groupId: item.groupId,
      agentId: item.agentId,
      agentHost: item.agentHost,
      agentPort: item.agentPort,
      status: item.status,
      statusDesc: taskStatus === undefined ? "未知" : (status[taskStatus] ?? "未知"),
      creator: item.creator,
      createTime: item.createTime,
      modifyTime: item.modifyTime,
      startTime: item.startTime,
      finishTime: item.finishTime,
      caseStats: {
        total: item.total,
        success: item.success,
        totalSuccess: item.totalSuccess,
        fail: item.fail,
        cancel: item.cancel,
        allCaseSize: item.allCaseSize,
      },
      retryInfo: {
        retryNum: item.retryNum,
        retriedNum: item.retriedNum,
      },
      notifyConfig: {
        isZh: item.isZh,
        isZhFail: item.isZhFail,
        isMail: item.isMail,
        informUserIds: item.informUserIds,
      },
      caseIncludeTagList: item.caseIncludeTagList,
      caseExcludeTagList: item.caseExcludeTagList,
      scriptGroupPath: item.scriptGroupPath,
      reportIndex: item.reportIndex,
      logFileIndex: item.logFileIndex,
      codeInfo: {
        giteeAddress: item.giteeAddress || null,
        codeBranch: item.codeBranch || null,
        codeRoot: item.codeRoot || null,
        scriptDirPath: item.scriptDirPath || "",
        customExecParams: item.customExecParams || null,
      },
      sandbox: {
        sandboxExecFlag: item.sandboxExecFlag,
        sandboxId: item.sandboxId || null,
        sandboxUrl: item.sandboxUrl || null,
      },
    },
  }
}

export function output(value: unknown) {
  return JSON.stringify(value, null, 2)
}

export function taskID(value: unknown) {
  return text(value)
}
