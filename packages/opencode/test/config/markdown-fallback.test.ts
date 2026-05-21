import { describe, expect, test } from "bun:test"
import { ConfigMarkdown } from "@/config/markdown"
import { Filesystem } from "@/util/filesystem"
import path from "path"
import os from "os"
import fs from "fs/promises"

describe("ConfigMarkdown fallback sanitization", () => {
  test("should handle missing space after colon (mode:Build)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-test-"))
    const testFile = path.join(tmpDir, "test.md")
    
    const content = `---
name: testspec
description: TestSpec workflow
mode:Build
---

# Test content
`
    
    await Filesystem.write(testFile, content)
    
    try {
      const result = await ConfigMarkdown.parse(testFile)
      expect(result.data.name).toBe("testspec")
      expect(result.data.mode).toBe("Build")
      expect(result.content.trim()).toBe("# Test content")
    } finally {
      await fs.rm(tmpDir, { recursive: true })
    }
  })

  test("should handle multiple missing spaces", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-test-"))
    const testFile = path.join(tmpDir, "test.md")
    
    const content = `---
name:test
description:Test description
mode:Build
agent:default
---

# Content
`
    
    await Filesystem.write(testFile, content)
    
    try {
      const result = await ConfigMarkdown.parse(testFile)
      expect(result.data.name).toBe("test")
      expect(result.data.description).toBe("Test description")
      expect(result.data.mode).toBe("Build")
      expect(result.data.agent).toBe("default")
    } finally {
      await fs.rm(tmpDir, { recursive: true })
    }
  })

  test("should still handle normal YAML correctly", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "testagent-test-"))
    const testFile = path.join(tmpDir, "test.md")
    
    const content = `---
name: testspec
description: TestSpec workflow
mode: Build
---

# Test content
`
    
    await Filesystem.write(testFile, content)
    
    try {
      const result = await ConfigMarkdown.parse(testFile)
      expect(result.data.name).toBe("testspec")
      expect(result.data.mode).toBe("Build")
    } finally {
      await fs.rm(tmpDir, { recursive: true })
    }
  })
})
