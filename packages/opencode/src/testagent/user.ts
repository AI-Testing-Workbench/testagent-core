// testagent_change - new file
// Stores the current user info set by the VS Code extension via HTTP or env vars.
import * as Log from "@opencode-ai/core/util/log"
import * as Observability from "@opencode-ai/core/effect/observability"

const log = Log.create({ service: "testagent.user" })

interface UserInfo {
  userId?: string
  userName?: string
  sapId?: string
  openId?: string
  originPathId?: string
  pathName?: string
  token?: string
}

let override: UserInfo | undefined
let cachedFromFile: UserInfo | undefined
let fileReadAttempted = false
const initialEnv: UserInfo = {
  userId: process.env["TESTAGENT_USER_ID"],
  userName: process.env["TESTAGENT_USER_NAME"],
  sapId: process.env["TESTAGENT_SAP_ID"],
  openId: process.env["TESTAGENT_OPEN_ID"],
  originPathId: process.env["TESTAGENT_ORIGIN_PATH_ID"],
  pathName: process.env["TESTAGENT_PATH_NAME"],
  token: process.env["TESTAGENT_USER_TOKEN"],
}

export const User = {
  get(): UserInfo {
    // override takes precedence (set by VS Code extension via HTTP)
    if (override?.userId) {
      log.debug("from override", { user: override })
      return override
    }
    
    // Preserve the initial process values. Custom environment variables can later
    // override process.env, but they must not change the automatic system identity.
    const fromEnv = initialEnv
    // 环境变量能提供完整身份时才直接返回；只提供了部分字段时留到下面与文件合并
    if (fromEnv.userId && fromEnv.originPathId) {
      log.debug("from env", { user: fromEnv })
      return fromEnv
    }
    
    // last resort: try to read from external-auth token file (synchronously, once)
    if (!fileReadAttempted) {
      fileReadAttempted = true
      try {
        const path = require("path")
        const fs = require("fs")
        const os = require("os")
        
        // Manually construct the path instead of importing Global module
        // This avoids the top-level await issue during build
        const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
        const file = path.join(xdgData, "testagent", "external-user.json")
        
        log.debug("checking file", { file })
        if (fs.existsSync(file)) {
          const data = JSON.parse(fs.readFileSync(file, "utf8"))
          if (data.userId && data.userName) {
            cachedFromFile = { 
              userId: data.userId, 
              userName: data.userName, 
              sapId: data.sapId,
              openId: data.openId,
              originPathId: data.originPathId,
              pathName: data.pathName,
              token: data.token
            }
            log.debug("from file", { user: cachedFromFile })
          }
        } else {
          log.debug("file does not exist", { file })
        }
      } catch (e) {
        log.warn("file read error", { error: e })
        // ignore errors, just return empty
      }
    }
    
    const fromFile = cachedFromFile ?? {
      userId: undefined,
      userName: undefined,
      sapId: undefined,
      openId: undefined,
      originPathId: undefined,
      pathName: undefined,
      token: undefined,
    }
    // 环境变量只提供了部分字段（例如注入的 TESTAGENT_ORIGIN_PATH_ID 缺失、但会话保留了 userId）时，
    // 用文件里的值补齐；否则远程接口会因为拿不到 pathCode 而永远跳过拉取。
    // 同一字段仍以环境变量优先，保证自定义环境变量不会改变系统身份。
    const result: UserInfo = fromEnv.userId
      ? {
          userId: fromEnv.userId || fromFile.userId,
          userName: fromEnv.userName || fromFile.userName,
          sapId: fromEnv.sapId || fromFile.sapId,
          openId: fromEnv.openId || fromFile.openId,
          originPathId: fromEnv.originPathId || fromFile.originPathId,
          pathName: fromEnv.pathName || fromFile.pathName,
          token: fromEnv.token || fromFile.token,
        }
      : fromFile
    log.debug("final result", { user: result })
    return result
  },
  set(info: UserInfo) {
    log.debug("set", { user: info })
    override = info
    Observability.setUser(info.userId ?? "", info.userName ?? "", info.pathName)
  },
}

const initial = User.get()
if (initial.userId || initial.userName) {
  Observability.setUser(initial.userId ?? "", initial.userName ?? "", initial.pathName)
}
