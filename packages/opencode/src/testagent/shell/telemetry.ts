// testagent_change - new file
// Shell 执行可观测性：判定命令风格、失败类型，并记录指标。
//
// 目的是回答一个产品问题：把 Windows 上 bash 工具的 shell 从 PowerShell 换成
// ps-bash 后，LLM 输出 POSIX 命令导致的失败是否真的减少了。
//
// 记指标时绝不记录完整命令或输出，只记录归一化特征，避免把业务 URL、参数、
// 令牌写进遥测。

import { Effect, Metric } from "effect"
import {
  shellCallTotal,
  shellCallFailed,
  shellCallDuration,
} from "@opencode-ai/core/effect/observability"

export type Style = "bash" | "native"

export type Failure =
  | "alias_hijack"
  | "param_binding"
  | "json_invalid"
  | "host_loader"
  | "syntax"
  | "not_found"
  | "other"

// PowerShell 系 shell 才会把 bash 命令搞坏，ps-bash 本身就是 bash 语义。
const POWERSHELL = new Set(["pwsh", "powershell"])

/** 命令里出现 POSIX-only 语法或参数，说明模型是按 bash 写的。 */
export function style(command: string): Style {
  // 命令替换、组合、管道是最强的信号
  if (/[^\\]`[^`]+`/.test(command)) return "bash"
  if (/\$\([^)]+\)/.test(command)) return "bash"
  if (/&&|\|\|/.test(command)) return "bash"
  if (/\|\|?\s*(grep|sed|awk|sort|cut|tr|head|tail|uniq|wc|xargs|find)\b/.test(command)) return "bash"
  // POSIX 工具名直接出现（在 PowerShell 里这些会命中别名或不存在）
  if (/(^|[;&|]\s*)(grep|sed|awk|sort|cut|tr|uniq|xargs|chmod|chown|find)\b/.test(command)) return "bash"
  // bash 风格短参数：-rf、-la、-k5、-n1、--name、-H、-d
  if (/(^|\s)(curl|wget)\s+(.+\s)?(-[a-zA-Z]|--[a-zA-Z])/.test(command)) return "bash"
  if (/\s-rf\b|\s-la\b|\s-k\d|\s-n\d|\s-maxdepth\b/.test(command)) return "bash"
  // 单引号包 JSON 是 bash 习惯（PowerShell 里同样会踩 native 参数边界）
  if (/'[^']*\{[^']*"[^']*'/.test(command)) return "bash"
  return "native"
}

const PATTERNS: Array<[Failure, RegExp]> = [
  ["alias_hijack", /Invoke-WebRequest|Invoke-RestMethod/i],
  ["param_binding", /ParameterBindingException|CannotConvertArgument|无法绑定参数|找不到与参数名称|A parameter cannot be found/i],
  ["json_invalid", /json_invalid|Expecting property name enclosed in double quotes/i],
  ["host_loader", /hostfxr|coreclr|Unable to load DLL|ps-bash-host|You must install or update \.NET|Framework not found/i],
  ["syntax", /Unexpected token|Missing closing|表达式或语句中包含意外的标记|ParserError/i],
  ["not_found", /不是内部或外部命令|CommandNotFoundException|is not recognized as an internal or external command/i],
]

/**
 * 判断一次调用是否失败以及失败类型。
 *
 * 只在「非零退出」或「输出命中已知错误特征」时算失败：很多命令会正常返回非零码
 * （如 grep 没匹配到），所以单看退出码会误报，必须叠加输出特征或明确的错误退出。
 */
export function classify(output: string, code: number | null | undefined): Failure | undefined {
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(output)) return kind
  }
  if (code === null || code === undefined) return undefined
  if (code === 0) return undefined
  return "other"
}

export function name(file: string) {
  return file.replace(/\\/g, "/").split("/").pop()?.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase() || file
}

export interface Report {
  shell: string
  command: string
  output: string
  code?: number | null
  ms: number
  modelID?: string
  providerID?: string
  platform?: string
}

/** 失败时记录命令原文：指标属性带短文本（聚合分析），日志带长文本（排查现场）。 */
const MAX_LOG = 2_000
const MAX_ATTR = 200

/** 记录一次 bash 工具调用：总数、风格、失败、耗时，全部带 shell 维度。 */
export function record(input: Report) {
  const kind = name(input.shell)
  const styleKind = style(input.command)
  const base = {
    shell: kind,
    style: styleKind,
    platform: input.platform ?? process.platform,
    modelID: input.modelID ?? "",
    providerID: input.providerID ?? "",
  }

  const failed = classify(input.output, input.code)
  const updates = [
    Metric.update(Metric.withAttributes(shellCallTotal, base), 1),
    Metric.update(Metric.withAttributes(shellCallDuration, base), Math.max(0, input.ms)),
  ]
  if (failed) {
    const short = input.command.replaceAll("\n", " ")
    const cmd = short.length > MAX_ATTR ? `${short.slice(0, MAX_ATTR)}…` : short
    updates.push(Metric.update(Metric.withAttributes(shellCallFailed, { ...base, failure: failed, command: cmd }), 1))
    const long = input.command.length > MAX_LOG ? `${input.command.slice(0, MAX_LOG)}…` : input.command
    updates.push(
      Effect.logWarning(
        `shell call failed shell="${kind}" style="${styleKind}" failure="${failed}" exit=${input.code ?? "null"} ms=${input.ms} command="${long}"`,
        { shell: kind, style: styleKind, failure: failed, exit: input.code ?? null, ms: input.ms, command: long },
      ),
    )
  }
  return updates
}

/** 是否为会踩 PowerShell 参数边界的 shell，用于报告时区分基线与实验组。 */
export function isPowerShell(shell: string) {
  return POWERSHELL.has(name(shell))
}
