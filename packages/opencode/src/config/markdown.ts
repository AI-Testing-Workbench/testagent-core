import { NamedError } from "@opencode-ai/core/util/error"
import matter from "gray-matter"
import { z } from "zod"
import { Filesystem } from "@/util/filesystem"

export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g
export const SHELL_REGEX = /!`([^`]+)`/g

export function files(template: string) {
  return Array.from(template.matchAll(FILE_REGEX))
}

export function shell(template: string) {
  return Array.from(template.matchAll(SHELL_REGEX))
}

// other coding agents like claude code allow invalid yaml in their
// frontmatter, we need to fallback to a more permissive parser for those cases
export function fallbackSanitization(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content

  const frontmatter = match[1]
  const lines = frontmatter.split(/\r?\n/)
  const result: string[] = []

  for (const line of lines) {
    // skip comments and empty lines
    if (line.trim().startsWith("#") || line.trim() === "") {
      result.push(line)
      continue
    }

    // skip lines that are continuations (indented)
    if (line.match(/^\s+/)) {
      result.push(line)
      continue
    }

    // testagent_change start - handle missing space after colon (e.g., "mode:Build")
    // First try to match key:value without space
    const noSpaceMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):([^\s].*)$/)
    if (noSpaceMatch) {
      // Add the missing space
      const key = noSpaceMatch[1]
      const value = noSpaceMatch[2].trim()
      result.push(`${key}: ${value}`)
      continue
    }
    // testagent_change end

    // match key: value pattern
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!kvMatch) {
      result.push(line)
      continue
    }

    const key = kvMatch[1]
    const value = kvMatch[2].trim()

    // skip if value is empty, already quoted, or uses block scalar
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) {
      result.push(line)
      continue
    }

    // if value contains a colon, convert to block scalar
    if (value.includes(":")) {
      result.push(`${key}: |-`)
      result.push(`  ${value}`)
      continue
    }

    result.push(line)
  }

  const processed = result.join("\n")
  return content.replace(frontmatter, () => processed)
}

export async function parse(filePath: string) {
  const template = await Filesystem.readText(filePath)

  try {
    const md = matter(template)
    // testagent_change start - detect if gray-matter returned malformed data
    // If data is a string instead of an object, it means parsing failed silently
    if (typeof md.data === "string") {
      throw new Error("gray-matter returned string data, likely due to malformed YAML")
    }
    // testagent_change end
    return md
  } catch {
    try {
      return matter(fallbackSanitization(template))
    } catch (err) {
      // testagent_change start - provide helpful error message
      let message = `${filePath}: YAML frontmatter 解析失败`

      if (err instanceof Error) {
        const errorMsg = err.message

        // Detect common errors and provide fixes
        if (errorMsg.includes("can not read a block mapping entry") || errorMsg.includes("implicit key")) {
          message += "\n\n常见问题：YAML 键值对缺少空格"
          message += "\n例如：'mode:Build' 应该改为 'mode: Build'"
          message += "\n\n请检查 front matter 中的所有键值对是否有空格分隔"
        } else {
          message += `: ${errorMsg}`
        }
      }
      // testagent_change end
      
      throw new FrontmatterError(
        {
          path: filePath,
          message,
        },
        { cause: err },
      )
    }
  }
}

export const FrontmatterError = NamedError.create(
  "ConfigFrontmatterError",
  z.object({
    path: z.string(),
    message: z.string(),
  }),
)

export * as ConfigMarkdown from "./markdown"
