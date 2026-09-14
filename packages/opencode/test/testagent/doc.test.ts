// testagent_change - new file
import { describe, it, expect } from "bun:test"
import { Doc } from "../../src/testagent/doc"

describe("testagent.doc", () => {
  it("isDoc 识别 .doc/.docx（大小写不敏感）", () => {
    expect(Doc.isDoc("a.doc")).toBe(true)
    expect(Doc.isDoc("a.DOCX")).toBe(true)
    expect(Doc.isDoc("a.txt")).toBe(false)
    expect(Doc.isDoc("a.xls")).toBe(false)
  })

  it("HTML 伪装 .doc（charset=gb2312 声明 + GBK 字节）正确解码提取", async () => {
    // 审=C9F3 核=BACB
    const head = Buffer.from('<html><head><meta charset="gb2312"></head><body><table><tr><td>')
    const body = Buffer.from([0xc9, 0xf3, 0xba, 0xcb])
    const tail = Buffer.from("</td><td>42</td></tr></table></body></html>")
    const out = await Doc.extract("/tmp/fake.doc", Buffer.concat([head, body, tail]))
    expect(out).toContain("审核")
    expect(out).toContain("42")
    expect(out).not.toMatch(/\uFFFD/)
  })

  it("RTF 伪装 .doc：\\'hh 按 GBK 解码，\\par 转换行，控制字剥离", async () => {
    // 表=B1ED；\\u34920 = 表；\\uc1 表示每个 \uN 后跟 1 个回退字符
    const rtf = Buffer.from("{\\rtf1\\ansi\\ansicpg936\\uc1\\pard name\\'b1\\'ed\\par \\u34920 ?", "binary")
    const out = await Doc.extract("/tmp/fake2.doc", rtf)
    expect(out).toContain("name表")
    expect(out).toContain("表")
    expect(out).not.toMatch(/\\par|\\'b1|ansicpg/)
  })

  it("Word2003 XML 伪装 .doc：剥标签保段落", async () => {
    const xml = Buffer.from('<?xml version="1.0"?><w:wordDocument><w:p><w:r><w:t>报告标题</w:t></w:r></w:p><w:p><w:r><w:t>正文行</w:t></w:r></w:p></w:wordDocument>', "utf-8")
    const out = await Doc.extract("/tmp/fake3.doc", xml)
    expect(out).toContain("报告标题")
    expect(out).toContain("正文行")
  })

  it("纯文本伪装 .doc 原样返回", async () => {
    const out = await Doc.extract("/tmp/t.doc", Buffer.from("普通文本内容\n第二行"))
    expect(out).toContain("普通文本内容")
  })

  it("空文件/损坏容器抛 ParseError 而非裸异常", async () => {
    await expect(Doc.extract("/tmp/e.doc", new Uint8Array())).rejects.toThrow(/文件为空/)
    const fakeZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x99, 0x99, 0x99, 0x99])
    await expect(Doc.extract("/tmp/b.doc", fakeZip)).rejects.toThrow(/解析失败|未解析到/)
  })

  it("真实 .doc/.docx（textutil 生成，本地夹具存在时校验）", async () => {
    const f = "/tmp/xlsfix/real.doc"
    const file = Bun.file(f)
    if (!(await file.exists())) return
    const out = await Doc.extract(f, new Uint8Array(await file.arrayBuffer()))
    expect(out).toContain("数据中心SQL审核")
    expect(out).toContain("T_SQL_CONFIG")
    const f2 = "/tmp/xlsfix/real.docx"
    const out2 = await Doc.extract(f2, new Uint8Array(await Bun.file(f2).arrayBuffer()))
    expect(out2).toContain("慢SQL")
  })
})
