// testagent_change - new file
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Path } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "testagent.env-vars" })

interface EnvVar {
  key: string
  value: string
  description?: string
}

interface EnvVarGroups {
  system: Record<string, EnvVar>
  custom: Record<string, EnvVar>
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

const managedCustomKeys = new Set<string>()

// 校验 key 格式
function validateKey(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)
}

// 获取存储路径
function getStoragePath(): string {
  return join(Path.data, "env-vars.json")
}

// 读取环境变量
async function load(): Promise<Record<string, EnvVar>> {
  const filepath = getStoragePath()
  try {
    const content = await readFile(filepath, "utf-8")
    const data = JSON.parse(content)
    if (typeof data !== "object" || data === null) {
      log.warn("env-vars.json is not an object, resetting to empty", { data })
      return {}
    }
    
    const validated: Record<string, EnvVar> = {}
    const invalidEntries: InvalidEnvVarEntry[] = []
    
    for (const [key, value] of Object.entries(data)) {
      // 检查 key 格式
      if (!validateKey(key)) {
        invalidEntries.push({ key, message: "格式非法（必须以字母或下划线开头，只能包含字母、数字和下划线）" })
        continue
      }
      
      // 检查 value 结构
      if (typeof value !== "object" || value === null) {
        invalidEntries.push({ key, message: "值结构非法（必须是对象）" })
        continue
      }
      
      const envVar = value as any
      
      // 检查必填字段
      if (typeof envVar.key !== "string" || typeof envVar.value !== "string") {
        invalidEntries.push({ key, message: "缺少必填字段（key 和 value 必须是字符串）" })
        continue
      }
      
      // 检查 key 一致性
      if (envVar.key !== key) {
        invalidEntries.push({ key, message: `内外不一致（外层键名: ${key}, 内层 key: ${envVar.key}）` })
        continue
      }
      
      // 检查 value 非空
      if (envVar.value === "") {
        invalidEntries.push({ key, message: "value 不能为空字符串" })
        continue
      }
      
      validated[key] = {
        key: envVar.key,
        value: envVar.value,
        description: typeof envVar.description === "string" ? envVar.description : undefined,
      }
    }
    
    // 如果存在非法条目，抛出错误
    if (invalidEntries.length > 0) {
      log.error("invalid entries in env-vars.json", { count: invalidEntries.length, invalidEntries })
      throw new EnvVarsConfigInvalidError(filepath, invalidEntries)
    }
    
    return validated
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
async function save(vars: Record<string, EnvVar>): Promise<void> {
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

// 获取自动注入的系统环境变量
async function getSystem(): Promise<Record<string, EnvVar>> {
  const { User } = await import("./user")
  const user = User.get()
  if (!user) return {}

  const system: Record<string, EnvVar> = {}
  if (user.userId) {
    system.TESTAGENT_USER_ID = {
      key: "TESTAGENT_USER_ID",
      value: user.userId,
      description: "当前用户 ID（自动注入）",
    }
  }
  if (user.userName) {
    system.TESTAGENT_USER_NAME = {
      key: "TESTAGENT_USER_NAME",
      value: user.userName,
      description: "当前用户名（自动注入）",
    }
  }
  if (user.sapId) {
    system.TESTAGENT_SAP_ID = {
      key: "TESTAGENT_SAP_ID",
      value: user.sapId,
      description: "当前用户 SAP ID（自动注入）",
    }
  }
  if (user.openId) {
    system.TESTAGENT_OPEN_ID = {
      key: "TESTAGENT_OPEN_ID",
      value: user.openId,
      description: "当前用户 Open ID（自动注入）",
    }
  }
  if (user.originPathId) {
    system.TESTAGENT_ORIGIN_PATH_ID = {
      key: "TESTAGENT_ORIGIN_PATH_ID",
      value: user.originPathId,
      description: "当前源路径 ID（自动注入）",
    }
  }
  if (user.pathName) {
    system.TESTAGENT_PATH_NAME = {
      key: "TESTAGENT_PATH_NAME",
      value: user.pathName,
      description: "当前路径名称（自动注入）",
    }
  }
  if (user.token) {
    system.TESTAGENT_USER_TOKEN = {
      key: "TESTAGENT_USER_TOKEN",
      value: user.token,
      description: "当前用户令牌（自动注入）",
    }
  }
  return system
}

// 获取环境变量，按来源分组展示
async function getAll(): Promise<EnvVarGroups> {
  const [system, custom] = await Promise.all([getSystem(), load()])
  log.debug("getAll", { system: Object.keys(system).length, custom: Object.keys(custom).length })
  return { system, custom }
}

// 按 Key 列表批量查询
async function query(keys: string[]): Promise<EnvVarGroups> {
  const allVars = await getAll()
  
  const system: Record<string, EnvVar> = {}
  const custom: Record<string, EnvVar> = {}
  
  for (const key of keys) {
    if (allVars.custom[key]) {
      custom[key] = allVars.custom[key]
    } else if (allVars.system[key]) {
      system[key] = allVars.system[key]
    }
  }
  
  log.debug("query env vars", { requested: keys.length, system: Object.keys(system).length, custom: Object.keys(custom).length })
  return { system, custom }
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
    vars[item.key] = item
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
    vars[item.key] = item
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

// 转换为环境变量对象（用于注入到进程）
async function toEnv(): Promise<Record<string, string>> {
  const vars = await getAll()
  const env = Object.fromEntries(
    Object.values({ ...vars.system, ...vars.custom }).map((variable) => [variable.key, variable.value]),
  )
  log.debug("toEnv", { count: Object.keys(env).length })
  return env
}

// 更新 process.env（用于运行时同步）
// 系统变量始终保留；仅追踪并删除此前注入、现已移除的自定义变量。
async function syncToProcessEnv(): Promise<void> {
  const vars = await getAll()
  const customKeys = new Set(Object.keys(vars.custom))
  const keysToDelete = [...managedCustomKeys].filter((key) => !customKeys.has(key))

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
  for (const variable of Object.values(vars.custom)) {
    process.env[variable.key] = variable.value
  }

  managedCustomKeys.clear()
  for (const key of customKeys) {
    managedCustomKeys.add(key)
  }

  log.info("synced to process.env", {
    system: Object.keys(vars.system).length,
    custom: customKeys.size,
    removed: keysToDelete.length,
  })
}

export const EnvVars = {
  getAll,
  query,
  batchCreate,
  batchUpdate,
  batchDelete,
  toEnv,
  syncToProcessEnv,
  validateKey,
}
