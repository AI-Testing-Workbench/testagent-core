// testagent_change - new file
// Stores the current user info set by the VS Code extension via HTTP or env vars.

interface UserInfo {
  id?: string
  name?: string
}

let override: UserInfo | undefined
let cachedFromFile: UserInfo | undefined
let fileReadAttempted = false

export const User = {
  get(): UserInfo {
    // override takes precedence (set by VS Code extension via HTTP)
    if (override?.id) {
      console.log("[testagent] User.get() from override:", override)
      return override
    }
    
    // fall back to env vars written by thread.ts after external auth
    const fromEnv = {
      id: process.env["TESTAGENT_USER_ID"],
      name: process.env["TESTAGENT_USER_NAME"],
    }
    if (fromEnv.id) {
      console.log("[testagent] User.get() from env:", fromEnv)
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
        
        console.log("[testagent] User.get() checking file:", file)
        if (fs.existsSync(file)) {
          const data = JSON.parse(fs.readFileSync(file, "utf8"))
          if (data.userId && data.userName) {
            cachedFromFile = { id: data.userId, name: data.userName }
            console.log("[testagent] User.get() from file:", cachedFromFile)
          }
        } else {
          console.log("[testagent] User.get() file does not exist")
        }
      } catch (e) {
        console.log("[testagent] User.get() file read error:", e)
        // ignore errors, just return empty
      }
    }
    
    const result = cachedFromFile ?? { id: undefined, name: undefined }
    console.log("[testagent] User.get() final result:", result)
    return result
  },
  set(info: UserInfo) {
    console.log("[testagent] User.set():", info)
    override = info
  },
}
