import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ManagedRuntime } from "effect"
import { Git } from "../../src/git"
import { WorktreeDiff } from "../../src/testagent/review/worktree-diff"
import { tmpdir } from "../fixture/fixture"

/** Build a body of `count` rows, the first `changed` of which hold new content. */
function body(count: number, changed: number, ending: string): string {
  const rows = Array.from({ length: count }, (_, index) => {
    const n = index + 1
    return n <= changed ? `changed ${n}` : `line ${n}`
  })
  return rows.join(ending) + ending
}

async function withGit<T>(run: (rt: ManagedRuntime.ManagedRuntime<Git.Service, never>) => Promise<T>): Promise<T> {
  const rt = ManagedRuntime.make(Git.defaultLayer)
  try {
    return await run(rt)
  } finally {
    await rt.dispose()
  }
}

async function withDiff<T>(
  run: (rt: ManagedRuntime.ManagedRuntime<WorktreeDiff.Service, never>) => Promise<T>,
): Promise<T> {
  const rt = ManagedRuntime.make(WorktreeDiff.defaultLayer)
  try {
    return await run(rt)
  } finally {
    await rt.dispose()
  }
}

/** Commit `doc.txt` with LF content, then rewrite it on disk with `ending`. */
async function seed(dir: string, ending: string, changed: number) {
  const file = path.join(dir, "doc.txt")
  await fs.writeFile(file, body(20, 0, "\n"), "utf-8")
  await $`git add doc.txt`.cwd(dir).quiet()
  await $`git commit -m base`.cwd(dir).quiet()
  await fs.writeFile(file, body(20, changed, ending), "utf-8")
}

/**
 * Windows checkouts hold CRLF on disk while the repository stores LF. The git
 * service runs with `core.autocrlf=false`, so an end-of-line agnostic diff is
 * what keeps counts and rendered patches aligned with `git diff`.
 */
describe("Git end-of-line handling", () => {
  test("stats() does not count CRLF differences as changes", async () => {
    await using tmp = await tmpdir({ git: true })
    await seed(tmp.path, "\r\n", 5)

    await withGit(async (rt) => {
      const stats = await rt.runPromise(Git.Service.use((git) => git.stats(tmp.path, "HEAD")))
      const entry = stats.find((item) => item.file === "doc.txt")
      expect(entry?.additions).toBe(5)
      expect(entry?.deletions).toBe(5)
    })
  })

  test("patch() contains exactly the changed rows", async () => {
    await using tmp = await tmpdir({ git: true })
    await seed(tmp.path, "\r\n", 5)

    await withGit(async (rt) => {
      const patch = await rt.runPromise(Git.Service.use((git) => git.patch(tmp.path, "HEAD", "doc.txt")))
      const rows = patch.text.split("\n")
      const removed = rows.filter((line) => line.startsWith("-line ") || line.startsWith("-changed "))
      const added = rows.filter((line) => line.startsWith("+line ") || line.startsWith("+changed "))
      expect(removed).toHaveLength(5)
      expect(added).toHaveLength(5)
    })
  })

  test("full() omits a file whose only difference is the line ending", async () => {
    await using tmp = await tmpdir({ git: true })
    await seed(tmp.path, "\r\n", 0)

    // `--name-status` reports the file because the raw bytes differ, while
    // `--numstat` reports nothing at all. The list is built from both, so the row
    // must be dropped instead of surfacing as a phantom `+0 -0`.
    await withGit(async (rt) => {
      const diff = await rt.runPromise(Git.Service.use((git) => git.diff(tmp.path, "HEAD")))
      expect(diff.map((item) => item.file)).toContain("doc.txt")
    })

    await withDiff(async (rt) => {
      const items = await rt.runPromise(WorktreeDiff.Service.use((wt) => wt.full({ dir: tmp.path, base: "HEAD" })))
      expect(items).toHaveLength(0)
    })
  })

  test("full() normalizes line endings and keeps the small counts", async () => {
    await using tmp = await tmpdir({ git: true })
    await seed(tmp.path, "\r\n", 5)

    await withDiff(async (rt) => {
      const items = await rt.runPromise(WorktreeDiff.Service.use((wt) => wt.full({ dir: tmp.path, base: "HEAD" })))
      const item = items.find((entry) => entry.file === "doc.txt")
      expect(item).toBeDefined()
      expect(item?.additions).toBe(5)
      expect(item?.deletions).toBe(5)
      expect(item?.before).not.toContain("\r")
      expect(item?.after).not.toContain("\r")
      expect(item?.patch).not.toContain("\r")
    })
  })
})
