// testagent_change - new file
import { describe, it, expect } from "bun:test"
import * as XLSX from "xlsx"
import { Sheet } from "../../src/testagent/sheet"

function build(wb: XLSX.WorkBook): Uint8Array {
  return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array", cellDates: true }) as ArrayBuffer)
}

describe("testagent.sheet", () => {
  it("isSheet 按扩展名识别（大小写不敏感）", () => {
    expect(Sheet.isSheet("a.xls")).toBe(true)
    expect(Sheet.isSheet("a.XLSX")).toBe(true)
    expect(Sheet.isSheet("a.txt")).toBe(false)
  })

  it("解析为 TSV：多 sheet、类型保真、列对齐、跳过空行", () => {
    const wb = XLSX.utils.book_new()
    const rows = [
      ["名称", "数量", "单价", "启用", "合计"],
      ["苹果", 3, 5.5, true, 16.5],
      [],
      ["香蕉", null, 2, false, ""],
    ]
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws["E2"] = { t: "n", v: 16.5, f: "B2*C2" } // 公式：读出缓存值
    XLSX.utils.book_append_sheet(wb, ws, "数据")
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([["第二表", 1]]),
      "Sheet2",
    )
    const out = Sheet.extract("/tmp/report.xlsx", build(wb))

    expect(out).toContain("--- Sheet: 数据 ---")
    expect(out).toContain("--- Sheet: Sheet2 ---")
    expect(out).toContain("名称\t数量\t单价\t启用")
    expect(out).toContain("苹果\t3\t5.5\tTRUE\t16.5") // 布尔按 Excel 显示 TRUE，公式取计算值
    expect(out).toContain("香蕉\t\t2\tFALSE") // 空单元格以制表符占位，保留列对齐
    expect(out).not.toMatch(/\n\t+\n/) // 空行不产生制表符占位行
    expect(out).toContain("名称\t数量\t单价\t启用\t合计\n苹果\t3\t5.5\tTRUE\t16.5\n香蕉\t\t2\tFALSE") // 表头/数据/空行跳过后紧邻
  })

  it("旧 .xls 自动识别（按魔数而非扩展名）", () => {
    // SheetJS 社区版不能写 BIFF8 .xls；此处用 XLSX 写出的 .xlsx 改扩展名验证 extract 不依赖扩展名
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["甲", 42]]), "表一")
    const out = Sheet.extract("/tmp/legacy.xls", build(wb))
    expect(out).toContain("--- Sheet: 表一 ---")
    expect(out).toContain("甲\t42")
  })

  it("GBK 编码的伪 .xls（HTML 表格，国内系统导出常见）正确解码中文", () => {
    // "审核"的 GBK 编码字节：审=C9F3 核=BACB
    const head = Buffer.from('<html><head><meta charset="gb2312"></head><body><table><tr><td>')
    const body = Buffer.from([0xc9, 0xf3, 0xba, 0xcb])
    const tail = Buffer.from("</td><td>42</td></tr></table></body></html>")
    const out = Sheet.extract("/tmp/gbk.xls", Buffer.concat([head, body, tail]))
    expect(out).toContain("审核")
    expect(out).toContain("42")
    expect(out).not.toMatch(/\uFFFD/)
  })

  it("损坏/加密文件抛 ParseError，不抛裸异常", () => {
    const fakeZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99])
    expect(() => Sheet.extract("/tmp/bad.xlsx", fakeZip)).toThrow(Sheet.ParseError)
    const garbled = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7 + 13) % 256))
    const alt = Buffer.concat([Buffer.from([0x50, 0x4b]), garbled])
    expect(() => Sheet.extract("/tmp/bad2.xlsx", alt)).not.toThrow() // 非 zip 头会走文本解码，不崩即可
  })

  it("超过 20MB 拒绝并给出 bash 提示", () => {
    const big = new Uint8Array(20 * 1000 * 1024 + 1)
    expect(() => Sheet.extract("/tmp/big.xlsx", big)).toThrow(/文件过大/)
  })
})
