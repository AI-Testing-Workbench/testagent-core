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
  shellCallNonzero,
  shellCallDuration,
} from "@opencode-ai/core/effect/observability"

export type Style = "Linux风格" | "本地风格"

export type Failure =
  | "别名劫持"
  | "参数绑定失败"
  | "JSON参数损坏"
  | "ps-bash无法启动"
  | "语法解析错误"
  | "命令不存在"
  | "非零退出"

// PowerShell 系 shell 才会把 bash 命令搞坏，ps-bash 本身就是 bash 语义。
const POWERSHELL = new Set(["pwsh", "powershell"])

/** 命令含只有 Linux/bash 才认的语法或参数，说明模型是按 Linux 习惯写的。 */
export function style(command: string): Style {
  // 命令替换、组合、管道是最强的信号
  if (/[^\\]`[^`]+`/.test(command)) return "Linux风格"
  if (/\$\([^)]+\)/.test(command)) return "Linux风格"
  if (/&&|\|\|/.test(command)) return "Linux风格"
  if (/\|\|?\s*(grep|sed|awk|sort|cut|tr|head|tail|uniq|wc|xargs|find)\b/.test(command)) return "Linux风格"
  // POSIX 工具名直接出现（在 PowerShell 里这些会命中别名或不存在）
  if (/(^|[;&|]\s*)(grep|sed|awk|sort|cut|tr|uniq|xargs|chmod|chown|find)\b/.test(command)) return "Linux风格"
  // bash 风格短参数：-rf、-la、-k5、-n1、--name、-H、-d
  if (/(^|\s)(curl|wget)\s+(.+\s)?(-[a-zA-Z]|--[a-zA-Z])/.test(command)) return "Linux风格"
  if (/\s-rf\b|\s-la\b|\s-k\d|\s-n\d|\s-maxdepth\b/.test(command)) return "Linux风格"
  // 单引号包 JSON 是 bash 习惯（PowerShell 里同样会踩 native 参数边界）
  if (/'[^']*\{[^']*"[^']*'/.test(command)) return "Linux风格"
  return "本地风格"
}

const PATTERNS: Array<[Failure, RegExp]> = [
  ["别名劫持", /Invoke-WebRequest|Invoke-RestMethod/i],
  ["参数绑定失败", /ParameterBindingException|CannotConvertArgument|无法绑定参数|找不到与参数名称|A parameter cannot be found/i],
  ["JSON参数损坏", /json_invalid|Expecting property name enclosed in double quotes/i],
  ["ps-bash无法启动", /hostfxr|coreclr|Unable to load DLL|ps-bash-host|You must install or update \.NET|Framework not found/i],
  ["语法解析错误", /Unexpected token|Missing closing|表达式或语句中包含意外的标记|ParserError/i],
  ["命令不存在", /不是内部或外部命令|CommandNotFoundException|is not recognized as an internal or external command/i],
]

/**
 * 判断一次调用是否失败以及失败类型。
 *
 * 只有输出命中已知错误特征才算 shell 层失败。非零退出但没有任何错误特征时返回
 * `非零退出`：这类命令（grep 无匹配、curl 连不上、ps-bash 透传不准的退出码等）
 * 本身执行是正常的，计入失败会虚增失败率，单独用 nonzero 计数器监控。
 */
export function classify(output: string, code: number | null | undefined): Failure | undefined {
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(output)) return kind
  }
  if (code === null || code === undefined) return undefined
  if (code === 0) return undefined
  return "非零退出"
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
  if (failed === "非零退出") {
    updates.push(Metric.update(Metric.withAttributes(shellCallNonzero, base), 1))
    return updates
  }
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
