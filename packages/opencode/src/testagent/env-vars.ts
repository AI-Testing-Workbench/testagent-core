// testagent_change - new file
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Path } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { base64Decode } from "@opencode-ai/core/util/encode"

const log = Log.create({ service: "testagent.env-vars" })

interface EnvVar {
  key: string
  value: string
}

type CustomEnvVars = Record<string, string>

interface EnvVarGroups {
  system: Record<string, EnvVar>
  custom: Record<string, EnvVar>
  remote: Record<string, EnvVar>
}

interface InvalidEnvVarEntry {
  key: string
  message: string
}

export class EnvVarsConfigInvalidError extends Error {
  constructor(
    readonly filepath: string,
    readonly invalidEntries: InvalidEnvVarEntry[],
  ) {
    super([
      `环境变量配置文件包含 ${invalidEntries.length} 个非法条目，请手动修改配置文件：`,
      `文件路径: ${filepath}`,
      "",
      "非法条目详情:",
      ...invalidEntries.map((entry, index) => `  ${index + 1}. Key "${entry.key}": ${entry.message}`),
    ].join("\n"))
    this.name = "EnvVarsConfigInvalidError"
  }
}

// 记录此前注入过 process.env 的自定义/远程变量 key，用于在变量被移除时精确清理
const managedKeys = new Set<string>()

// 校验 key 格式
function validateKey(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)
}

// 获取存储路径（自定义变量与远程接口变量共用该文件）
function getStoragePath(): string {
  return join(Path.data, "env-vars.json")
}

// 读取环境变量
async function load(): Promise<CustomEnvVars> {
  const filepath = getStoragePath()
  try {
    const data: unknown = JSON.parse(await readFile(filepath, "utf-8"))
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new EnvVarsConfigInvalidError(filepath, [{ key: "<root>", message: "根节点必须是对象" }])
    }

    const entries = Object.entries(data)
    const invalidEntries = entries.flatMap(([key, value]): InvalidEnvVarEntry[] => {
      if (!validateKey(key)) {
        return [{ key, message: "格式非法（必须以字母或下划线开头，只能包含字母、数字和下划线）" }]
      }
      if (typeof value !== "string") {
        return [{ key, message: "value 必须是字符串" }]
      }
      if (!value) {
        return [{ key, message: "value 不能为空字符串" }]
      }
      return []
    })

    if (invalidEntries.length > 0) {
      log.error("invalid entries in env-vars.json", { count: invalidEntries.length, invalidEntries })
      throw new EnvVarsConfigInvalidError(filepath, invalidEntries)
    }

    return Object.fromEntries(entries) as CustomEnvVars
  } catch (err: any) {
    if (err.code === "ENOENT") {
      log.debug("env-vars.json does not exist, returning empty")
      return {}
    }
    if (err instanceof EnvVarsConfigInvalidError) {
      throw err
    }
    log.error("failed to read env-vars.json", { err: err.message })
    throw new Error(`Failed to read environment variables: ${err.message}`)
  }
}

// 保存环境变量
async function save(vars: CustomEnvVars): Promise<void> {
  const filepath = getStoragePath()
  const dir = join(Path.data)
  
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(filepath, JSON.stringify(vars, null, 2), "utf-8")
    log.debug("saved env-vars", { count: Object.keys(vars).length })
  } catch (err: any) {
    log.error("failed to save env-vars.json", { err: err.message })
    throw new Error(`Failed to save environment variables: ${err.message}`)
  }
}

// 保存远程接口变量：与自定义变量合并写入同一文件
async function saveRemote(vars: CustomEnvVars): Promise<void> {
  const stored = await load()
  await save({ ...stored, ...vars })
  log.debug("saved remote env-vars", { count: Object.keys(vars).length })
}

// ── 远程接口 ──────────────────────────────────────────────────────────────

interface RemoteResponse {
  returnCode?: string
  returncode?: string
  errorMsg?: string
  // 接口在无数据时可能返回 body: null；字段名为小写，取值时按归一化后的名字匹配
  body?: Record<string, unknown> | null
}

const REMOTE_SUCCESS_CODE = "SUC0000"

// 接口地址（base64 编码，可用 TESTAGENT_KEY_URL 覆盖），pathCode 取自 User.originPathId
const encodedUrl =
  "aHR0cHM6Ly90ZXN0aHViLWdhdGV3YXkucGFhcy5jbWJjaGluYS5jbi9hcHBsaWNhdGlvbi1rZXkvdHMtY29kZS9ieS1kZXB0"

// 接口字段（小写） -> 环境变量 key（统一 TESTAGENT 前缀 + 大写）
const remoteFields: Array<[string, string]> = [
  ["appid", "TESTAGENT_APP_ID"],
  ["secret", "TESTAGENT_SECRET"],
  ["publickey", "TESTAGENT_PUBLIC_KEY"],
  ["privatekey", "TESTAGENT_PRIVATE_KEY"],
]

// 远程接口变量 key 集合：与自定义变量同文件存储，读取时据此分组，同时作为「是否已拉取过」的判定依据
const remoteKeys = new Set(remoteFields.map(([, key]) => key))

// 字段名归一化：忽略大小写与分隔符差异，接口返回 appid / appId / APP_ID 都能命中同一个 key
function normalizeField(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase()
}

// 展开错误链：fetch 失败时真实原因（DNS/TLS/代理/超时）通常挂在 cause 上，
// 只记 message 会丢掉关键信息（例如证书校验失败的具体原因）
function describeError(err: any): Record<string, unknown> {
  const cause = err?.cause
  return {
    err: err?.message || String(err),
    name: err?.name,
    code: err?.code,
    cause: cause?.code || cause?.message || (cause ? String(cause) : undefined),
  }
}

// 读取响应体片段用于日志，读取失败不影响主流程
async function readBody(res: Response): Promise<string | undefined> {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return undefined
  }
}

// 调接口获取密钥对；网络异常/非 2xx 时返回 undefined
async function requestRemote(pathCode: string): Promise<RemoteResponse | undefined> {
  const url = process.env["TESTAGENT_KEY_URL"] || base64Decode(encodedUrl)
  const target = `${url}?pathCode=${encodeURIComponent(pathCode)}`
  // 用 info 级别记录目标地址：打包后的扩展默认只输出 INFO，用 debug 会看不到请求是否真的发出去了
  log.info("requesting remote env vars", { url: target })

  try {
    const res = await fetch(target, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) {
      log.warn("remote request returned non-ok status", {
        url: target,
        status: res.status,
        body: await readBody(res),
      })
      return undefined
    }
    const data = (await res.json()) as RemoteResponse | null
    // 接口可能返回字面量 null，此时视为无数据
    if (!data || typeof data !== "object") {
      log.warn("remote request returned an empty payload", { url: target })
      return undefined
    }
    return data
  } catch (err: any) {
    log.warn("remote request failed", { url: target, ...describeError(err) })
    return undefined
  }
}

// 解析接口返回并映射为环境变量，返回码非成功时抛错
function parseRemote(res: RemoteResponse): CustomEnvVars {
  const code = res.returnCode ?? res.returncode
  if (code !== REMOTE_SUCCESS_CODE) {
    throw new Error(`remote request failed: ${code ?? "no returnCode"}${res.errorMsg ? ` ${res.errorMsg}` : ""}`)
  }
  // 接口在无数据时可能返回 body: null，此时视为没有可用字段
  const body = res.body
  if (!body) {
    log.warn("remote response body is empty")
    return {}
  }

  // 接口字段名为小写，先归一化再匹配；兼容接口直接返回变量名本身（如 testagent_app_id）
  const fields = new Map<string, unknown>()
  for (const [name, value] of Object.entries(body)) fields.set(normalizeField(name), value)

  const vars: CustomEnvVars = {}
  for (const [field, key] of remoteFields) {
    const value = fields.get(normalizeField(field)) ?? fields.get(normalizeField(key))
    if (typeof value === "string" && value) vars[key] = value
  }
  return vars
}

// 获取自动注入的系统环境变量
async function getSystem(): Promise<Record<string, EnvVar>> {
  const { User } = await import("./user")
  const user = User.get()
  if (!user) return {}

  return {
    ...(user.userId ? { TESTAGENT_USER_ID: { key: "TESTAGENT_USER_ID", value: user.userId } } : {}),
    ...(user.userName ? { TESTAGENT_USER_NAME: { key: "TESTAGENT_USER_NAME", value: user.userName } } : {}),
    ...(user.sapId ? { TESTAGENT_SAP_ID: { key: "TESTAGENT_SAP_ID", value: user.sapId } } : {}),
    ...(user.openId ? { TESTAGENT_OPEN_ID: { key: "TESTAGENT_OPEN_ID", value: user.openId } } : {}),
    ...(user.originPathId
      ? { TESTAGENT_ORIGIN_PATH_ID: { key: "TESTAGENT_ORIGIN_PATH_ID", value: user.originPathId } }
      : {}),
    ...(user.pathName ? { TESTAGENT_PATH_NAME: { key: "TESTAGENT_PATH_NAME", value: user.pathName } } : {}),
    ...(user.token ? { TESTAGENT_USER_TOKEN: { key: "TESTAGENT_USER_TOKEN", value: user.token } } : {}),
  }
}

// 把扁平存储转换为分组结构
function group(vars: CustomEnvVars): Record<string, EnvVar> {
  return Object.fromEntries(Object.entries(vars).map(([key, value]) => [key, { key, value }]))
}

// 获取环境变量，按来源分组展示（自定义与远程接口变量存于同一文件，按 key 区分）
async function getAll(): Promise<EnvVarGroups> {
  const [system, stored] = await Promise.all([getSystem(), load()])
  const custom: CustomEnvVars = {}
  const remote: CustomEnvVars = {}
  for (const [key, value] of Object.entries(stored)) {
    if (remoteKeys.has(key)) remote[key] = value
    else custom[key] = value
  }
  log.debug("getAll", {
    system: Object.keys(system).length,
    custom: Object.keys(custom).length,
    remote: Object.keys(remote).length,
  })
  return { system, custom: group(custom), remote: group(remote) }
}

// 按 Key 列表批量查询
async function query(keys: string[]): Promise<EnvVarGroups> {
  const allVars = await getAll()
  
  const system: Record<string, EnvVar> = {}
  const custom: Record<string, EnvVar> = {}
  const remote: Record<string, EnvVar> = {}
  
  for (const key of keys) {
    if (allVars.custom[key]) {
      custom[key] = allVars.custom[key]
    } else if (allVars.remote[key]) {
      remote[key] = allVars.remote[key]
    } else if (allVars.system[key]) {
      system[key] = allVars.system[key]
    }
  }
  
  log.debug("query env vars", {
    requested: keys.length,
    system: Object.keys(system).length,
    custom: Object.keys(custom).length,
    remote: Object.keys(remote).length,
  })
  return { system, custom, remote }
}

interface BatchResult {
  successKeys: string[]
  failedKeys: string[]
  failedEntries: InvalidEnvVarEntry[]
}

// 批量新增环境变量
async function batchCreate(items: EnvVar[]): Promise<BatchResult> {
  const vars = await load()
  const successKeys: string[] = []
  const failedEntries: InvalidEnvVarEntry[] = []
  const seenKeys = new Set<string>()
  
  for (const item of items) {
    const message = !validateKey(item.key)
      ? "Key 格式非法（必须以字母或下划线开头，只能包含字母、数字和下划线）"
      : item.value === ""
        ? "value 不能为空字符串"
        : vars[item.key]
          ? "Key 已存在"
          : seenKeys.has(item.key)
            ? "请求中存在重复的 Key"
            : undefined
    if (message) {
      failedEntries.push({ key: item.key, message })
      continue
    }
    seenKeys.add(item.key)
    vars[item.key] = item.value
    successKeys.push(item.key)
  }
  
  const failedKeys = failedEntries.map((entry) => entry.key)
  if (successKeys.length > 0) {
    await save(vars)
    log.info("batch create env vars", { success: successKeys.length, failed: failedKeys.length })
  } else {
    log.warn("batch create: all items failed", { failed: failedKeys.length })
  }
  
  return { successKeys, failedKeys, failedEntries }
}

// 批量更新环境变量
async function batchUpdate(items: EnvVar[]): Promise<BatchResult> {
  const vars = await load()
  const successKeys: string[] = []
  const failedEntries: InvalidEnvVarEntry[] = []
  const lastIndexes = new Map(items.map((item, index) => [item.key, index]))
  
  for (const [index, item] of items.entries()) {
    const message = !validateKey(item.key)
      ? "Key 格式非法（必须以字母或下划线开头，只能包含字母、数字和下划线）"
      : item.value === ""
        ? "value 不能为空字符串"
        : !vars[item.key]
          ? "Key 不存在"
          : lastIndexes.get(item.key) !== index
            ? "请求中存在重复的 Key，仅最后一个条目会生效"
            : undefined
    if (message) {
      failedEntries.push({ key: item.key, message })
      continue
    }
    vars[item.key] = item.value
    successKeys.push(item.key)
  }
  
  const failedKeys = [...new Set(failedEntries.map((entry) => entry.key))]
  if (successKeys.length > 0) {
    await save(vars)
    log.info("batch update env vars", { success: successKeys.length, failed: failedKeys.length })
  } else {
    log.warn("batch update: all items failed", { failed: failedKeys.length })
  }
  
  return { successKeys, failedKeys, failedEntries }
}

// 批量删除环境变量
async function batchDelete(keys: string[]): Promise<void> {
  const vars = await load()
  let deletedCount = 0
  
  for (const key of keys) {
    if (key in vars) {
      delete vars[key]
      deletedCount++
    }
  }
  
  if (deletedCount > 0) {
    await save(vars)
    log.info("batch delete env vars", { deleted: deletedCount, ignored: keys.length - deletedCount })
  } else {
    log.debug("batch delete: no keys found", { keys: keys.length })
  }
}

// 更新 process.env（用于运行时同步）
// 系统变量始终保留；仅追踪并删除此前注入、现已移除的自定义/远程变量。
async function syncToProcessEnv(): Promise<void> {
  const vars = await getAll()
  const nowManaged = new Set([...Object.keys(vars.custom), ...Object.keys(vars.remote)])
  const keysToDelete = [...managedKeys].filter((key) => !nowManaged.has(key))

  for (const key of keysToDelete) {
    if (key in vars.system) {
      process.env[key] = vars.system[key].value
      continue
    }
    delete process.env[key]
  }

  for (const variable of Object.values(vars.system)) {
    process.env[variable.key] = variable.value
  }
  for (const variable of Object.values(vars.remote)) {
    process.env[variable.key] = variable.value
  }
  for (const variable of Object.values(vars.custom)) {
    process.env[variable.key] = variable.value
  }

  managedKeys.clear()
  for (const key of nowManaged) {
    managedKeys.add(key)
  }

  log.info("synced to process.env", {
    system: Object.keys(vars.system).length,
    custom: Object.keys(vars.custom).length,
    remote: Object.keys(vars.remote).length,
    removed: keysToDelete.length,
  })
}

// 是否已存在远程接口变量（env-vars.json 中任意远程字段 key）
async function hasRemote(): Promise<boolean> {
  const vars = await load()
  return Object.keys(vars).some((key) => remoteKeys.has(key))
}

// 启动时确保远程接口变量存在：
// 已存在（env-vars.json 中已有远程字段）则跳过，保持原有数据；缺失则调接口拉取、落盘并同步到 process.env。
// 拉取失败不阻断启动，保留旧行为。
async function ensureRemote(): Promise<{ created: boolean; keys: string[] }> {
  if (await hasRemote()) {
    log.info("remote env vars already present, skip fetching")
    return { created: false, keys: [] }
  }

  try {
    const { User } = await import("./user")
    const user = User.get()
    const pathCode = user.originPathId
    if (!pathCode) {
      // 打印已拿到的字段：区分「完全没有用户信息」和「只有身份、缺 originPathId」两种情况
      log.warn("originPathId missing, skip fetching remote env vars", { fields: Object.keys(user) })
      return { created: false, keys: [] }
    }

    const res = await requestRemote(pathCode)
    if (!res) return { created: false, keys: [] }

    const vars = parseRemote(res)
    const keys = Object.keys(vars)
    if (keys.length === 0) {
      // 字段名对不上时把原始返回打出来，便于对照接口实际字段
      log.warn("remote response contained no usable fields", {
        pathCode,
        returnCode: res.returnCode ?? res.returncode,
        body: res.body,
      })
      return { created: false, keys: [] }
    }
    await saveRemote(vars)
    await syncToProcessEnv()
    log.info("fetched remote env vars", { pathCode, keys })
    return { created: true, keys }
  } catch (err: any) {
    log.warn("failed to fetch remote env vars", { err: err?.message || String(err) })
    return { created: false, keys: [] }
  }
}

// 清理远程接口变量（登出时调用）：从 env-vars.json 删掉远程字段并从 process.env 移除，自定义变量保持不动
async function clearRemote(): Promise<void> {
  const stored = await load()
  const kept = Object.fromEntries(Object.entries(stored).filter(([key]) => !remoteKeys.has(key)))
  if (Object.keys(kept).length !== Object.keys(stored).length) await save(kept)
  await syncToProcessEnv()
  log.info("cleared remote env vars")
}

export const EnvVars = {
  getAll,
  query,
  batchCreate,
  batchUpdate,
  batchDelete,
  syncToProcessEnv,
  hasRemote,
  ensureRemote,
  clearRemote,
  validateKey,
}
