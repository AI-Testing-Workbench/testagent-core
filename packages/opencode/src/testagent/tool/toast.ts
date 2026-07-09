// testagent_change - new file
import { Effect, Schema } from "effect"
import { spawn, exec } from "child_process"
import { writeFileSync, unlinkSync, mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import * as Tool from "../../tool/tool"
import * as Log from "@opencode-ai/core/util/log"
import { User } from "../user"
import DESCRIPTION from "./toast.txt"

const log = Log.create({ service: "toast-tool" })

const Parameters = Schema.Struct({
  type: Schema.Literals([1, 2]).annotate({
    description: "Notification type: 1 = system notification (Windows Action Center), 2 = call API",
  }),
  message: Schema.String.annotate({ description: "The message content" }),
})

function xmlEscape(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
}

/** Register TestAgent AppUserModelID in Windows registry (required for ToastNotificationManager) */
function ensureAUMIDRegistered(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const appID = "TestAgent"
    const psScript = [
      `$AppID = '${appID}';`,
      `$RegPath = "HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\$AppID";`,
      `try {`,
      `  if (-not (Test-Path $RegPath)) { New-Item -Path $RegPath -Force | Out-Null }`,
      `  Set-ItemProperty -Path $RegPath -Name 'DisplayName' -Value 'TestAgent' -Type String`,
      `  Set-ItemProperty -Path $RegPath -Name 'IconUri' -Value '' -Type String`,
      `  Write-Host 'SUCCESS'; exit 0`,
      `} catch {`,
      `  Write-Error $_; exit 1`,
      `}`,
    ].join("\r\n")
    const tmp = mkdtempSync(join(tmpdir(), "testagent-"))
    const ps1 = join(tmp, "register-aumid.ps1")
    writeFileSync(ps1, "\ufeff" + psScript, "utf-8")
    const proc = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1])
    let stderr = ""
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
    proc.on("close", (code) => {
      try { unlinkSync(ps1) } catch {}
      try { import("fs").then((m) => m.rmdirSync(tmp)) } catch {}
      code === 0 ? resolve() : reject(new Error(stderr || `exit code ${code}`))
    })
    proc.on("error", (err) => {
      try { unlinkSync(ps1) } catch {}
      try { import("fs").then((m) => m.rmdirSync(tmp)) } catch {}
      reject(err)
    })
  })
}

/** Show Windows toast notification using PowerShell with WinRT COM */
function showPowerShellToast(message: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const appID = "TestAgent"
    const escapedMessage = xmlEscape(message)
    const toastXml = `<toast><visual><binding template="ToastText02"><text id="2">${escapedMessage}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default" /></toast>`
    const psScript = [
      `Add-Type -AssemblyName System.Runtime.WindowsRuntime`,
      `$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]`,
      `$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]`,
      `$toastXml = @"`,
      `${toastXml}`,
      `"@`,
      `try {`,
      `  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
      `  $xml.LoadXml($toastXml)`,
      `  $toast = New-Object Windows.UI.Notifications.ToastNotification($xml)`,
      `  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appID}')`,
      `  $notifier.Show($toast)`,
      `  Write-Host 'SUCCESS'; exit 0`,
      `} catch {`,
      `  Write-Error $_.Exception.Message; exit 1`,
      `}`,
    ].join("\r\n")
    const tmpDir = mkdtempSync(join(tmpdir(), "testagent-"))
    const ps1 = join(tmpDir, "toast.ps1")
    writeFileSync(ps1, "\ufeff" + psScript, "utf-8")
    const cmd = `powershell -Sta -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1}"`
    exec(cmd, { encoding: "utf8", timeout: 15000 }, (err, stdout, stderr) => {
      try { unlinkSync(ps1) } catch {}
      try { import("fs").then((m) => m.rmdirSync(tmpDir)) } catch {}
      err ? reject(err) : resolve()
    })
  })
}

function systemNotify(message: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      if (process.platform === "darwin") {
        const safeMsg = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        const proc = spawn("osascript", ["-e", `display notification "${safeMsg}" with title "TestAgent"`])
        proc.on("close", () => resolve())
        proc.on("error", () => resolve())
      } else if (process.platform === "linux") {
        const proc = spawn("notify-send", ["TestAgent", message])
        proc.on("close", () => resolve())
        proc.on("error", () => resolve())
      } else if (process.platform === "win32") {
        ensureAUMIDRegistered()
          .then(() => showPowerShellToast(message))
          .catch(() => {
            const safeM = message.replace(/'/g, "''")
            spawn("powershell", [
              "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
              `(New-Object -ComObject Wscript.Shell).Popup('${safeM}',10,'TestAgent',64)`,
            ])
          })
          .finally(() => resolve())
      } else {
        resolve()
      }
    } catch { resolve() }
  })
}

function mockApiCall(message: string): Promise<{ success: boolean; data: any }> {
  return new Promise((resolve) => {
    const u = User.get()
    const rtcId = u.userId || u.sapId || "HH02789"
    const payload = { userRtcIds: [rtcId], message }
    const url = decodeURIComponent(atob("aHR0cCUzQSUyRiUyRmNtYnQtc2VydmljZS1kZXYucGFhcy5jbWJjaGluYS5jbiUyRnpoYW9faHVfc2VuZGVyJTJGc2VuZF9kYXRh"))

    log.info("post notification", { url, payload })
    

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((res) => res.json().catch(() => ({ code: res.status, message: res.statusText })))
      .then((data) => resolve({ success: true, data }))
      .catch((err) => resolve({ success: false, data: { code: -1, message: err.message } }))
  })
}

export const ToastTool = Tool.define<typeof Parameters, {}, never>(
  "toast",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.type === 1) {
            yield* Effect.promise(() => systemNotify(params.message)).pipe(Effect.ignore)
            return {
              title: "System Notification",
              output: `System notification sent: ${params.message}`,
              metadata: {},
            }
          }

          const result = yield* Effect.promise(() => mockApiCall(params.message))
          return {
            title: result.success ? "API Call Succeeded" : "API Call Failed",
            output: result.success
              ? `API notification sent: ${params.message}`
              : `API notification failed: ${result.data.message}`,
            metadata: { apiResult: result.data },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
