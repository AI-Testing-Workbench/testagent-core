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

export const User = {
  get(): UserInfo {
    // override takes precedence (set by VS Code extension via HTTP)
    if (override?.userId) {
      log.debug("from override", { user: override })
      return override
    }
    
    // fall back to env vars written by thread.ts after external auth
    const fromEnv = {
      userId: process.env["TESTAGENT_USER_ID"],
      userName: process.env["TESTAGENT_USER_NAME"],
      sapId: process.env["TESTAGENT_SAP_ID"],
      openId: process.env["TESTAGENT_OPEN_ID"],
      originPathId: process.env["TESTAGENT_ORIGIN_PATH_ID"],
      pathName: process.env["TESTAGENT_PATH_NAME"],
      token: process.env["TESTAGENT_USER_TOKEN"],
    }
    if (fromEnv.userId) {
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
    
    const result = cachedFromFile ?? { 
      userId: undefined, 
      userName: undefined, 
      sapId: undefined,
      openId: undefined,
      originPathId: undefined,
      pathName: undefined,
      token: undefined
    }
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
