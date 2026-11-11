import { describe, expect, test } from "bun:test"
import { classify, style, name, isPowerShell } from "../../src/testagent/shell/telemetry"

describe("shell telemetry", () => {
  test("detects bash-only command shapes", () => {
    // 命令替换 / 组合 / 管道
    expect(style("echo $(date)")).toBe("bash")
    expect(style("echo `date`")).toBe("bash")
    expect(style("make && echo ok")).toBe("bash")
    expect(style("ls -la | grep test")).toBe("bash")
    // POSIX 工具名
    expect(style("grep -rn foo .")).toBe("bash")
    expect(style("sort -k5 -h data.txt")).toBe("bash")
    expect(style("awk '{print $2}' f")).toBe("bash")
    // curl 参数是本次故障的主线
    expect(style(`curl -s -X POST "https://x" -H "Content-Type: application/json" -d '{"a":1}'`)).toBe("bash")
    // bash 短参数
    expect(style("rm -rf dist")).toBe("bash")
    expect(style("find . -maxdepth 1 -name x")).toBe("bash")
  })

  test("treats plain single-token commands as native", () => {
    expect(style("pwd")).toBe("native")
    expect(style("dir")).toBe("native")
    expect(style("node --version")).toBe("native")
    expect(style("Get-ChildItem -Recurse")).toBe("native")
  })

  test("classifies the PowerShell failures we are tracking", () => {
    // curl 被别名劫持成 Invoke-WebRequest
    expect(classify("Invoke-WebRequest : 无法绑定参数", 1)).toBe("alias_hijack")
    // 参数绑定失败
    expect(classify("ParameterBindingException: CannotConvertArgument", 1)).toBe("param_binding")
    // JSON body 被剥离引号
    expect(classify('{"detail":[{"msg":"JSON decode error"}]}\nExpecting property name enclosed in double quotes', 0)).toBe("json_invalid")
    // ps-bash 的 .NET host 故障
    expect(classify("Unable to load DLL 'hostfxr'", 1)).toBe("host_loader")
    // 找不到可执行文件
    expect(classify("bash: foo: command not found", 127)).toBe("other")
    expect(classify("'foo' 不是内部或外部命令", 1)).toBe("not_found")
  })

  test("does not flag successful commands", () => {
    expect(classify("hello\n", 0)).toBeUndefined()
    // grep 无匹配会返回 1，但这不是 shell 层故障
    expect(classify("", 1)).toBe("other")
  })

  test("normalizes shell names", () => {
    expect(name("C:/Users/x/ps-bash.exe")).toBe("ps-bash")
    expect(name("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell")
    expect(name("/bin/zsh")).toBe("zsh")
    expect(isPowerShell("C:/x/pwsh.exe")).toBe(true)
    expect(isPowerShell("C:/x/ps-bash.exe")).toBe(false)
  })
})
