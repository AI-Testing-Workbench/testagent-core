// testagent_change - new file
import { Context, Effect, Layer, Schema } from "effect"
import path from "node:path"
import { createTwoFilesPatch } from "diff"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Log from "@opencode-ai/core/util/log"
import { FileIgnore } from "@/file/ignore"
import { Git } from "@/git"
import { withStatics } from "@/util/schema"
import { zod } from "@/util/effect-zod"

const log = Log.create({ service: "worktree-diff" })

export namespace WorktreeDiff {
  export const Item = Schema.Struct({
    file: Schema.String,
    patch: Schema.String,
    before: Schema.String,
    after: Schema.String,
    additions: Schema.Number,
    deletions: Schema.Number,
    status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
    tracked: Schema.Boolean,
    generatedLike: Schema.Boolean,
    summarized: Schema.Boolean,
    stamp: Schema.String,
  })
    .annotate({ identifier: "WorktreeDiffItem" })
    .pipe(withStatics((s) => ({ zod: zod(s) })))

  export type Item = typeof Item.Type

  type Status = "added" | "deleted" | "modified"

  type Meta = {
    file: string
    additions: number
    deletions: number
    status: Status
    tracked: boolean
    generatedLike: boolean
    stamp: string
  }

  export interface Interface {
    readonly summary: (input: { dir: string; base: string }) => Effect.Effect<Item[]>
    readonly detail: (input: { dir: string; base: string; file: string }) => Effect.Effect<Item | undefined>
    readonly full: (input: { dir: string; base: string }) => Effect.Effect<Item[]>
  }

  export class Service extends Context.Service<Service, Interface>()("@testagent/WorktreeDiff") {}

  export const layer: Layer.Layer<Service, never, Git.Service | AppFileSystem.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const git = yield* Git.Service
      const fs = yield* AppFileSystem.Service

      const generatedLike = (file: string) => FileIgnore.match(file)

      const ancestor = Effect.fn("WorktreeDiff.ancestor")(function* (dir: string, base: string) {
        const result = yield* git.mergeBase(dir, base)
        if (!result) {
          log.warn("git merge-base failed", { dir, base })
        }
        return result
      })

      const stats = Effect.fn("WorktreeDiff.stats")(function* (dir: string, ancestorHash: string) {
        const list = yield* git.stats(dir, ancestorHash)
        const map = new Map<string, { additions: number; deletions: number }>()
        for (const item of list) {
          map.set(item.file, { additions: item.additions, deletions: item.deletions })
        }
        return map
      })

      const lineCount = Effect.fn("WorktreeDiff.lineCount")(function* (file: string) {
        const content = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
        if (!content) return 0
        const lines = content.split("\n")
        return content.endsWith("\n") ? lines.length - 1 : lines.length
      })

      const statStamp = Effect.fn("WorktreeDiff.statStamp")(function* (dir: string, file: string) {
        const stat = yield* fs.stat(path.join(dir, file)).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!stat) return `missing:${file}`
        const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
        const mtime = typeof stat.mtime === "bigint" ? Number(stat.mtime) : stat.mtime
        return `${size}:${mtime}`
      })

      const list = Effect.fn("WorktreeDiff.list")(function* (dir: string, ancestorHash: string) {
        const [diffItems, stat] = yield* Effect.all([git.diff(dir, ancestorHash), stats(dir, ancestorHash)], {
          concurrency: 2,
        })

        const result: Meta[] = []
        const seen = new Set<string>()

        for (const item of diffItems) {
          seen.add(item.file)
          const counts = stat.get(item.file) ?? { additions: 0, deletions: 0 }
          const stamp =
            item.status === "deleted" ? `deleted:${ancestorHash}` : yield* statStamp(dir, item.file)
          result.push({
            file: item.file,
            additions: counts.additions,
            deletions: counts.deletions,
            status: item.status as Status,
            tracked: true,
            generatedLike: generatedLike(item.file),
            stamp,
          })
        }

        const statusItems = yield* git.status(dir)
        const untrackedFiles = statusItems.filter((item) => item.status === "added" && !seen.has(item.file))

        for (const item of untrackedFiles) {
          const filePath = path.join(dir, item.file)
          const exists = yield* fs.exists(filePath).pipe(Effect.catch(() => Effect.succeed(false)))
          if (!exists) continue

          const additions = yield* lineCount(filePath)
          const stamp = yield* statStamp(dir, item.file)

          result.push({
            file: item.file,
            additions,
            deletions: 0,
            status: "added" as Status,
            tracked: false,
            generatedLike: generatedLike(item.file),
            stamp,
          })
        }

        return result
      })

      const detailMeta = Effect.fn("WorktreeDiff.detailMeta")(function* (
        dir: string,
        ancestorHash: string,
        file: string,
      ) {
        log.debug("detailMeta called", { dir, ancestor: ancestorHash.substring(0, 12), file })

        const statusItems = yield* git.status(dir)
        const statusItem = statusItems.find((item) => item.file === file)

        if (!statusItem) {
          log.debug("file not in status", { file })
          return undefined
        }

        if (statusItem.status === "added" && statusItem.code === "??") {
          log.debug("file not tracked", { file })
          const filePath = path.join(dir, file)
          const exists = yield* fs.exists(filePath).pipe(Effect.catch(() => Effect.succeed(false)))
          if (!exists) {
            log.debug("file does not exist", { file })
            return undefined
          }
          const additions = yield* lineCount(filePath)
          const stamp = yield* statStamp(dir, file)
          return {
            file,
            additions,
            deletions: 0,
            status: "added" as Status,
            tracked: false,
            generatedLike: generatedLike(file),
            stamp,
          }
        }

        const diffItems = yield* git.diff(dir, ancestorHash)
        const diffItem = diffItems.find((item) => item.file === file)

        if (!diffItem) {
          log.debug("no diff output for file", { file })
          return undefined
        }

        const statList = yield* git.stats(dir, ancestorHash)
        const statItem = statList.find((item) => item.file === file)
        const stat = statItem ?? { additions: 0, deletions: 0 }

        const stamp = diffItem.status === "deleted" ? `deleted:${ancestorHash}` : yield* statStamp(dir, file)

        log.debug("detailMeta result", {
          file,
          status: diffItem.status,
          additions: stat.additions,
          deletions: stat.deletions,
        })

        return {
          file,
          additions: stat.additions,
          deletions: stat.deletions,
          status: diffItem.status as Status,
          tracked: true,
          generatedLike: generatedLike(file),
          stamp,
        }
      })

      const readBefore = Effect.fn("WorktreeDiff.readBefore")(function* (
        dir: string,
        ancestorHash: string,
        file: string,
        status: Status,
      ) {
        if (status === "added") return ""
        const prefix = yield* git.prefix(dir)
        return yield* git.show(dir, ancestorHash, file, prefix)
      })

      const readAfter = Effect.fn("WorktreeDiff.readAfter")(function* (dir: string, file: string, status: Status) {
        if (status === "deleted") return ""
        const filePath = path.join(dir, file)
        const exists = yield* fs.exists(filePath).pipe(Effect.catch(() => Effect.succeed(false)))
        if (!exists) return ""
        return yield* fs.readFileString(filePath).pipe(Effect.catch(() => Effect.succeed("")))
      })

      const lines = (text: string) => {
        if (!text) return 0
        return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length
      }

      const load = Effect.fn("WorktreeDiff.load")(function* (
        dir: string,
        ancestorHash: string,
        meta: Meta,
      ) {
        const [before, after] = yield* Effect.all(
          [readBefore(dir, ancestorHash, meta.file, meta.status), readAfter(dir, meta.file, meta.status)],
          { concurrency: 2 },
        )
        const additions = meta.status === "added" && meta.additions === 0 && !meta.tracked ? lines(after) : meta.additions
        return {
          file: meta.file,
          patch: createTwoFilesPatch(meta.file, meta.file, before, after),
          before,
          after,
          additions,
          deletions: meta.deletions,
          status: meta.status,
          tracked: meta.tracked,
          generatedLike: meta.generatedLike,
          summarized: false,
          stamp: meta.stamp,
        }
      })

      const summarize = (meta: Meta): Item => ({
        file: meta.file,
        patch: "",
        before: "",
        after: "",
        additions: meta.additions,
        deletions: meta.deletions,
        status: meta.status,
        tracked: meta.tracked,
        generatedLike: meta.generatedLike,
        summarized: true,
        stamp: meta.stamp,
      })

      const summary = Effect.fn("WorktreeDiff.summary")(function* (input: { dir: string; base: string }) {
        const ancestorHash = yield* ancestor(input.dir, input.base)
        if (!ancestorHash) return []
        log.info("merge-base resolved", { ancestor: ancestorHash.slice(0, 12) })
        const items = yield* list(input.dir, ancestorHash)
        log.info("diff summary complete", { totalFiles: items.length })
        return items.map(summarize)
      })

      const detail = Effect.fn("WorktreeDiff.detail")(function* (input: {
        dir: string
        base: string
        file: string
      }) {
        const ancestorHash = yield* ancestor(input.dir, input.base)
        if (!ancestorHash) return undefined
        const meta = yield* detailMeta(input.dir, ancestorHash, input.file)
        if (!meta) return undefined
        return yield* load(input.dir, ancestorHash, meta)
      })

      const full = Effect.fn("WorktreeDiff.full")(function* (input: { dir: string; base: string }) {
        const ancestorHash = yield* ancestor(input.dir, input.base)
        if (!ancestorHash) return []
        log.info("merge-base resolved", { ancestor: ancestorHash.slice(0, 12) })
        const items = yield* list(input.dir, ancestorHash)
        const result = yield* Effect.all(items.map((item) => load(input.dir, ancestorHash, item)), {
          concurrency: 8,
        })
        log.info("diff complete", { totalFiles: result.length })
        return result
      })

      return Service.of({
        summary,
        detail,
        full,
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Git.defaultLayer), Layer.provide(AppFileSystem.defaultLayer))
}
