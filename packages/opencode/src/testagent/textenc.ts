// testagent_change - new file
export const MAX_BYTES = 20 * 1000 * 1024

export class ParseError extends Error {}

export const magic = (buffer: Uint8Array, m: number[]) => m.every((b, i) => buffer[i] === b)
export const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
export const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

export function toLabel(enc: string): string | undefined {
  const e = enc.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (e === "utf8" || e.startsWith("utf8")) return "utf-8"
  if (e === "gb2312" || e === "gbk" || e === "gb18030" || e === "cp936" || e === "windows936" || e === "936") return "gb18030"
  if (e === "big5" || e === "big5hkscs" || e === "cp950" || e === "950") return "big5"
  if (e === "iso88591" || e === "latin1" || e === "usascii" || e === "ascii" || e === "windows1252" || e === "1252") return "windows-1252"
  if (e === "utf16le" || e === "1200") return "utf-16le"
  if (e === "utf16be") return "utf-16be"
  return undefined
}

function garbage(s: string) {
  let bad = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13)) bad++
  }
  return s.length > 0 && bad / s.length > 0.1
}

// GB18030 ⊃ GBK ⊃ GB2312，一个解码器覆盖大陆简繁编码
export function decodeBytes(buffer: Uint8Array, prefers: string[] = []): string {
  const cands: string[] = []
  for (const p of prefers) if (p && !cands.includes(p)) cands.push(p)
  if (!cands.includes("utf-8")) cands.push("utf-8")
  if (!cands.includes("gb18030")) cands.push("gb18030")
  let last = ""
  for (const enc of cands) {
    let text: string
    try {
      text = new TextDecoder(enc, { fatal: enc === "utf-8" && prefers[0] !== "utf-8" }).decode(buffer)
    } catch {
      continue
    }
    if (!garbage(text)) return text
    last = last || text
  }
  return last
}

// 文本类伪 office 文件：BOM > encoding/charset 声明 > UTF-8 严格 > GB18030 兜底
export function decodeText(buffer: Uint8Array): string {
  if (magic(buffer, [0xff, 0xfe])) return new TextDecoder("utf-16le").decode(buffer)
  if (magic(buffer, [0xfe, 0xff])) return new TextDecoder("utf-16be").decode(buffer)
  if (magic(buffer, [0xef, 0xbb, 0xbf])) return new TextDecoder("utf-8").decode(buffer)
  const head = new TextDecoder("windows-1252").decode(buffer.subarray(0, 4096))
  const declared = head.match(/encoding\s*=\s*["']?\s*([\w-]+)/i)?.[1] ?? head.match(/charset\s*=\s*["']?\s*([\w-]+)/i)?.[1]
  return decodeBytes(buffer, declared ? [toLabel(declared)!] : [])
}
