import path from "path"
import TurndownService from "turndown"
import WordExtractor from "word-extractor"
import { decodeBytes, decodeText, magic, MAX_BYTES, OLE2_MAGIC, ParseError, toLabel, ZIP_MAGIC } from "./textenc"

const DOC_EXT = new Set([".doc", ".docx"])
// ponytail: 同 sheet 上限；全文导出过大时截断提示 bash
const MAX_CHARS = 400 * 1024

export { ParseError }

export function isDoc(filepath: string) {
  return DOC_EXT.has(path.extname(filepath).toLowerCase())
}

const down = new TurndownService({ headingStyle: "setext" })
// 报告是给 LLM 消费的文本，关掉 markdown 转义（T_USER → T\_USER 属于噪声）
down.escape = (s) => s

const entities = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCharCode(parseInt(c, 16)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")

function stripXml(src: string): string {
  // 段落/行尾标签先转换行，再剥全部标签，保留文本节点
  return entities(
    src
      .replace(/<\/(w:p|p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/[ \t]+\n/g, "\n"),
  )
}

// 旧式 destination 组（不带 *），内容非正文，整组跳过
const DEST = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "header", "footer", "footnote",
  "headerl", "headerr", "headerf", "footerl", "footerf", "footerr",
  "generator", "listtable", "listoverridetable", "latentstyles", "rsidtbl",
  "themebuildinstance", "colorschememapping", "datastore", "xmlnstbl", "pict",
])

// RTF: \'hh 字节对(按 ansicpg 解码) + \uN unicode(\ucN 声明其后跟随 N 个回退字符) + \par 换行；
// {\*...} destination 组(fonttbl/stylesheet 等)整组丢弃
function rtfText(src: string): string {
  const label = toLabel(src.match(/\\ansicpg(\d+)/i)?.[1] ?? "") ?? "gb18030"
  let out = ""
  let bytes: number[] = []
  let skip = 0
  let uc = 1
  let rowSkip = false
  const groups: boolean[] = []
  const dropped = () => groups.at(-1) ?? false
  const flush = () => {
    if (!bytes.length) return
    out += decodeBytes(Uint8Array.from(bytes), [label])
    bytes = []
  }
  const push = (b: number) => {
    if (dropped() || rowSkip) return
    if (skip > 0) return void skip--
    bytes.push(b)
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === "{") {
      // {\*\destination 语法：* 是紧跟 \ 的独立控制符号，整组非正文
      if (src[i + 1] === "\\" && src[i + 2] === "*") groups.push(true), (i += 3)
      else if (src[i + 1] === "*") groups.push(true), (i += 2)
      else groups.push(false), i++
      continue
    }
    if (c === "}") {
      flush()
      groups.pop()
      i++
      continue
    }
    if (c === "\r" || c === "\n") {
      i++
      continue
    }
    if (c !== "\\") {
      push(c.charCodeAt(0) & 0xff)
      i++
      continue
    }
    if (src[i + 1] === "'") {
      const hex = /^'([0-9a-fA-F]{2})/.exec(src.slice(i + 1, i + 4))
      if (hex) push(parseInt(hex[1]!, 16))
      i += 4
      continue
    }
    const word = /^[a-zA-Z]+(-?\d+)? ?/.exec(src.slice(i + 1))
    if (word) {
      const w = word[0].match(/^[a-zA-Z]+/)![0].toLowerCase()
      if (!dropped() && skip === 0) {
        if (DEST.has(w)) groups[groups.length - 1] = true
        else if (w === "trowd") rowSkip = true
        else if (w === "cellx") rowSkip = false
        else if (w === "row") flush(), rowSkip = false, (out += "\n")
        else if (w === "cell") flush(), (out += "\t")
        else if (w === "par" || w === "line" || w === "sect") flush(), (out += "\n")
        else if (w === "uc") uc = Number(/(\d+)/.exec(word[0])?.[1]) ?? 1
        else if (w === "u") {
          flush()
          const n = Number(/-?\d+/.exec(src.slice(i + 2))?.[0])
          if (Number.isFinite(n)) out += String.fromCharCode(n < 0 ? 65536 + n : n)
          skip = uc
        }
      }
      i += 1 + word[0].length
      continue
    }
    i += 2
  }
  flush()
  return out
}

const cap = (s: string) => {
  const out = s.replace(/\n{3,}/g, "\n\n").trim()
  if (!out) throw new ParseError("未解析到文本内容，文件可能与扩展名不符")
  return out.length > MAX_CHARS ? out.slice(0, MAX_CHARS) + "\n\n(内容已截断，全文请用 bash 工具读取)" : out
}

export async function extract(filepath: string, buffer: Uint8Array): Promise<string> {
  if (buffer.length > MAX_BYTES) throw new ParseError(`文件过大（${buffer.length} 字节，上限 ${MAX_BYTES}），请用 bash + python 解析`)
  if (!buffer.length) throw new ParseError("文件为空")

  if (magic(buffer, ZIP_MAGIC) || magic(buffer, OLE2_MAGIC)) {
    // 真 .doc(OLE2/Word97) 与 .docx(OOXML zip)：word-extractor 解析正文/页眉脚注，内部处理 codepage
    try {
      const doc = await new WordExtractor().extract(Buffer.from(buffer))
      const body = await doc.getBody()
      const heads = await doc.getHeaders()
      const headStr = Array.isArray(heads) ? heads.join("\n") : (heads ?? "")
      return cap([body, headStr].join("\n"))
    } catch (err) {
      throw new ParseError(`解析失败（文件可能损坏或加密）: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 文本类伪 .doc：HTML 报告 / Word2003 XML / RTF / 纯文本换名
  const text = decodeText(buffer)
  if (/^\{\\rtf/.test(text.trim())) return cap(rtfText(text))
  if (/<\?xml|<w:worddocument|<workbook|schemas-microsoft-com/i.test(text) && !/<\s*html/i.test(text)) return cap(stripXml(text))
  if (/<\s*(html|table|body|head)\b/i.test(text)) return cap(down.turndown(text))
  return cap(text)
}

export * as Doc from "./doc"
