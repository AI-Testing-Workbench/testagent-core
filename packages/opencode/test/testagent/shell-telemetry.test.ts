import { describe, expect, test } from "bun:test"
import { classify, style, name, isPowerShell } from "../../src/testagent/shell/telemetry"

describe("shell telemetry", () => {
  test("detects bash-only command shapes", () => {
    // 命令替换 / 组合 / 管道
    expect(style("echo $(date)")).toBe("Linux风格")
    expect(style("echo `date`")).toBe("Linux风格")
    expect(style("make && echo ok")).toBe("Linux风格")
    expect(style("ls -la | grep test")).toBe("Linux风格")
    // POSIX 工具名
    expect(style("grep -rn foo .")).toBe("Linux风格")
    expect(style("sort -k5 -h data.txt")).toBe("Linux风格")
    expect(style("awk '{print $2}' f")).toBe("Linux风格")
    // curl 参数是本次故障的主线
    expect(style(`curl -s -X POST "https://x" -H "Content-Type: application/json" -d '{"a":1}'`)).toBe("Linux风格")
    // bash 短参数
    expect(style("rm -rf dist")).toBe("Linux风格")
    expect(style("find . -maxdepth 1 -name x")).toBe("Linux风格")
  })

  test("treats plain single-token commands as native", () => {
    expect(style("pwd")).toBe("本地风格")
    expect(style("dir")).toBe("本地风格")
    expect(style("node --version")).toBe("本地风格")
    expect(style("Get-ChildItem -Recurse")).toBe("本地风格")
  })

  test("classifies the PowerShell failures we are tracking", () => {
    // curl 被别名劫持成 Invoke-WebRequest
    expect(classify("Invoke-WebRequest : 无法绑定参数", 1)).toBe("别名劫持")
    // 参数绑定失败
    expect(classify("ParameterBindingException: CannotConvertArgument", 1)).toBe("参数绑定失败")
    // JSON body 被剥离引号
    expect(classify('{"detail":[{"msg":"JSON decode error"}]}\nExpecting property name enclosed in double quotes', 0)).toBe("JSON参数损坏")
    // ps-bash 的 .NET host 故障
    expect(classify("Unable to load DLL 'hostfxr'", 1)).toBe("ps-bash无法启动")
    // 找不到可执行文件：英文文案不在特征表里，落入非零退出
    expect(classify("bash: foo: command not found", 127)).toBe("非零退出")
    expect(classify("'foo' 不是内部或外部命令", 1)).toBe("命令不存在")
  })

  test("does not flag successful commands", () => {
    expect(classify("hello\n", 0)).toBeUndefined()
    // grep 无匹配 / 退出码透传不准但无错误特征：不计入失败，单列非零退出
    expect(classify("", 1)).toBe("非零退出")
    expect(classify('{"ok":true,"data":[1,2]}', 3)).toBe("非零退出")
  })

  test("normalizes shell names", () => {
    expect(name("C:/Users/x/ps-bash.exe")).toBe("ps-bash")
    expect(name("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell")
    expect(name("/bin/zsh")).toBe("zsh")
    expect(isPowerShell("C:/x/pwsh.exe")).toBe(true)
    expect(isPowerShell("C:/x/ps-bash.exe")).toBe(false)
  })
})
