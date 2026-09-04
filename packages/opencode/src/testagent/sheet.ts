import path from "path"
import * as XLSX from "xlsx"
import { decodeText, magic, MAX_BYTES, OLE2_MAGIC, ParseError, ZIP_MAGIC } from "./textenc"

const SHEET_EXT = new Set([".xls", ".xlsx", ".xlsm", ".xlsb"])
// ponytail: 上限与 cline 对齐（20MB 文件、5 万行、400KB 输出）。超出截断并提示，需要全量时走 bash+python
const MAX_ROWS = 50000
const MAX_CHARS = 400 * 1024

export { ParseError }

export function isSheet(filepath: string) {
  return SHEET_EXT.has(path.extname(filepath).toLowerCase())
}

function num(v: number) {
  if (!Number.isFinite(v)) return String(v)
  // 防止 JS 将 >=1e21 的数值输出为科学计数法
  if (Math.abs(v) >= 1e21) return v.toFixed(0)
  return String(v)
}

function cell(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.t === "z") return ""
  // Excel 显示文本（含日期/数字格式化结果 w）与用户所见一致
  if (cell.w != null) return cell.w
  switch (cell.t) {
    case "b":
      return cell.v ? "TRUE" : "FALSE"
    case "e":
      return String(cell.v)
    case "d":
      return (cell.v as Date).toISOString().replace("T", " ").replace(/\.000Z$/, "")
    case "n":
      return cell.f ? `=[${cell.f}]` : num(cell.v as number)
    default:
      return cell.v == null ? "" : String(cell.v)
  }
}

export function extract(filepath: string, buffer: Uint8Array): string {
  if (buffer.length > MAX_BYTES) throw new ParseError(`文件过大（${buffer.length} 字节，上限 ${MAX_BYTES}），请用 bash + python 解析`)
  if (!buffer.length) throw new ParseError("文件为空")

  let wb: XLSX.WorkBook
  try {
    if (magic(buffer, ZIP_MAGIC) || magic(buffer, OLE2_MAGIC)) {
      // 真实 OOXML(.xlsx)/OLE2(.xls BIFF8/BIFF2/.xlsb)：SheetJS 按内部 codepage 解码
      wb = XLSX.read(buffer, { type: "array", cellDates: true })
    } else {
      // 容器非 zip/OLE2 → 文本类伪装 .xls（HTML 表格/SpreadsheetML/CSV，国内系统导出常见）：
      // 先按 BOM/声明/UTF-8/GB18030 解码，SheetJS type:"string" 可解析这三种格式
      wb = XLSX.read(decodeText(buffer), { type: "string", cellDates: true })
    }
  } catch (err) {
    throw new ParseError(`解析失败（文件可能损坏或加密）: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!wb.SheetNames.length) throw new ParseError("未解析到任何工作表内容，文件可能与扩展名格式不符")

  const hidden = new Set(
    (wb.Workbook?.Sheets ?? [])
      .map((s, i) => (s.Hidden ? wb.SheetNames[i] : null))
      .filter((n): n is string => n != null),
  )

  const parts: string[] = []
  let truncated = false
  for (const name of wb.SheetNames) {
    if (hidden.has(name)) continue
    const ws = wb.Sheets[name]
    if (!ws?.["!ref"]) continue
    const range = XLSX.utils.decode_range(ws["!ref"])
    const last = Math.min(range.e.r, range.s.r + MAX_ROWS - 1)
    truncated = truncated || last < range.e.r
    const rows: string[] = [`--- Sheet: ${name} ---`]
    for (let r = range.s.r; r <= last; r++) {
      const cols: string[] = []
      for (let c = range.s.c; c <= range.e.c; c++) {
        cols.push(cell(ws[XLSX.utils.encode_cell({ r, c })]))
      }
      // 整行为空则跳过（与 cline 一致）；空列以制表符占位保留列对齐
      if (cols.some((x) => x !== "")) rows.push(cols.join("\t"))
    }
    parts.push(rows.join("\n"))
  }

  let out = parts.join("\n\n")
  if (out.length > MAX_CHARS) {
    out = out.slice(0, MAX_CHARS)
    truncated = true
  }
  if (truncated)
    out += `\n\n(内容已截断，完整数据请用 bash 工具运行: python3 -c "import pandas as pd; print(pd.read_excel('${filepath.replaceAll("\\", "/")}').to_csv(index=False))")`
  return out.trim()
}

export * as Sheet from "./sheet"
