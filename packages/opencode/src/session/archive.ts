// testagent_change - new file
import { Database } from "@/storage/db"
import { MessageTable, PartTable, SessionTable } from "./session.sql"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { MessageID, PartID, SessionID } from "./schema"
import { Effect, Schema } from "effect"

export const Archive = Schema.Struct({
  info: Session.Info,
  messages: Schema.Array(
    Schema.Struct({
      info: MessageV2.Info,
      parts: Schema.Array(MessageV2.Part),
    }),
  ),
}).annotate({ identifier: "SessionArchive" })

export const ImportResult = Schema.Struct({
  sourceSessionID: SessionID,
  sessionID: SessionID,
  forked: Schema.Boolean,
}).annotate({ identifier: "SessionImportResult" })

export class InvalidForkArchiveError extends Schema.TaggedErrorClass<InvalidForkArchiveError>()(
  "SessionArchive.InvalidForkArchiveError",
  { message: Schema.String },
) {}

export const exportSession = Effect.fn("SessionArchive.exportSession")(function* (input: {
  session: Session.Interface
  sessionID: SessionID
  sanitize?: boolean
}) {
  const info = yield* input.session.get(input.sessionID)
  const messages = yield* input.session.messages({ sessionID: info.id })
  const archive = { info, messages }
  return input.sanitize ? (sanitize(archive) as typeof Archive.Type) : archive
})

export const importSession = Effect.fn("SessionArchive.importSession")(function* (input: {
  archive: typeof Archive.Type
  projectID: string
}) {
  const info = Schema.decodeUnknownSync(Session.Info)({
    ...input.archive.info,
    projectID: input.projectID,
  }) as Session.Info
  const row = Session.toRow(info)
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values(row)
      .onConflictDoUpdate({ target: SessionTable.id, set: { project_id: row.project_id } })
      .run(),
  )

  for (const msg of input.archive.messages) {
    const msgInfo = Schema.decodeUnknownSync(MessageV2.Info)(msg.info) as MessageV2.Info
    const { id, sessionID: _, ...msgData } = msgInfo
    Database.use((db) =>
      db
        .insert(MessageTable)
        .values({
          id,
          session_id: row.id,
          time_created: msgInfo.time?.created ?? Date.now(),
          data: msgData,
        })
        .onConflictDoNothing()
        .run(),
    )

    for (const item of msg.parts) {
      const part = Schema.decodeUnknownSync(MessageV2.Part)(item) as MessageV2.Part
      const { id: partID, sessionID: _sessionID, messageID, ...partData } = part
      Database.use((db) =>
        db
          .insert(PartTable)
          .values({
            id: partID,
            message_id: messageID,
            session_id: row.id,
            data: partData,
          })
          .onConflictDoNothing()
          .run(),
      )
    }
  }

  return row.id
})

export const forkSession = Effect.fn("SessionArchive.forkSession")(function* (input: { archive: typeof Archive.Type }) {
  const archive = Schema.decodeUnknownSync(Archive)(input.archive)
  const sourceMessageIDs = new Set(archive.messages.map((message) => message.info.id))
  const sourceParts = archive.messages.flatMap((message) => message.parts)
  const sourcePartIDs = new Set(sourceParts.map((part) => part.id))

  if (sourceMessageIDs.size !== archive.messages.length)
    return yield* new InvalidForkArchiveError({ message: "Archive contains duplicate message IDs" })
  if (sourcePartIDs.size !== sourceParts.length)
    return yield* new InvalidForkArchiveError({ message: "Archive contains duplicate part IDs" })
  if (
    archive.messages.some(
      (message) =>
        message.info.sessionID !== archive.info.id ||
        (message.info.role === "assistant" && !sourceMessageIDs.has(message.info.parentID)) ||
        message.parts.some((part) => part.sessionID !== archive.info.id || part.messageID !== message.info.id),
    )
  )
    return yield* new InvalidForkArchiveError({ message: "Archive contains an invalid session or message reference" })

  const messageIDs = new Map(archive.messages.map((message) => [message.info.id, MessageID.ascending()]))
  const partIDs = new Map(sourceParts.map((part) => [part.id, PartID.ascending()]))
  const info = yield* Session.forkInfo(Schema.decodeUnknownSync(Session.Info)(archive.info) as Session.Info)
  const sessionRow = Session.toRow(info)
  const messages = archive.messages.map((message) => {
    const id = messageIDs.get(message.info.id)!
    const messageInfo = (
      message.info.role === "assistant"
        ? {
            ...message.info,
            id,
            sessionID: info.id,
            parentID: messageIDs.get(message.info.parentID)!,
          }
        : { ...message.info, id, sessionID: info.id }
    ) as MessageV2.Info
    const { id: _, sessionID: _sessionID, ...data } = messageInfo
    return {
      id,
      session_id: info.id,
      time_created: messageInfo.time.created,
      data,
    }
  })
  const parts = archive.messages.flatMap((message) =>
    message.parts.map((part) => {
      const id = partIDs.get(part.id)!
      const messageID = messageIDs.get(part.messageID)!
      const source = (
        part.type === "compaction"
          ? {
              ...part,
              tail_start_id: part.tail_start_id ? messageIDs.get(part.tail_start_id) : undefined,
            }
          : part
      ) as MessageV2.Part
      const { id: _id, sessionID: _sessionID, messageID: _messageID, ...data } = source
      return {
        id,
        message_id: messageID,
        session_id: info.id,
        data,
      }
    }),
  )

  yield* Effect.sync(() =>
    Database.transaction((db) => {
      db.insert(SessionTable).values(sessionRow).run()
      if (messages.length) db.insert(MessageTable).values(messages).run()
      if (parts.length) db.insert(PartTable).values(parts).run()
    }),
  )

  return {
    sourceSessionID: archive.info.id,
    sessionID: info.id,
    forked: true,
  }
})

function redact(kind: string, id: string, value: string) {
  return value.trim() ? `[redacted:${kind}:${id}]` : value
}

function data(kind: string, id: string, value: Record<string, unknown> | undefined) {
  if (!value) return value
  return Object.keys(value).length ? { redacted: `${kind}:${id}` } : value
}

function span(id: string, value: { value: string; start: number; end: number }) {
  return {
    ...value,
    value: redact("file-text", id, value.value),
  }
}

function diff(kind: string, diffs: { file: string; patch: string }[] | undefined) {
  return diffs?.map((item, i) => ({
    ...item,
    file: redact(`${kind}-file`, String(i), item.file),
    patch: redact(`${kind}-patch`, String(i), item.patch),
  }))
}

function source(part: MessageV2.FilePart) {
  if (!part.source) return part.source
  if (part.source.type === "symbol") {
    return {
      ...part.source,
      path: redact("file-path", part.id, part.source.path),
      name: redact("file-symbol", part.id, part.source.name),
      text: span(part.id, part.source.text),
    }
  }
  if (part.source.type === "resource") {
    return {
      ...part.source,
      clientName: redact("file-client", part.id, part.source.clientName),
      uri: redact("file-uri", part.id, part.source.uri),
      text: span(part.id, part.source.text),
    }
  }
  return {
    ...part.source,
    path: redact("file-path", part.id, part.source.path),
    text: span(part.id, part.source.text),
  }
}

function filepart(part: MessageV2.FilePart): MessageV2.FilePart {
  return {
    ...part,
    url: redact("file-url", part.id, part.url),
    filename: part.filename === undefined ? undefined : redact("file-name", part.id, part.filename),
    source: source(part),
  }
}

function part(part: MessageV2.Part): MessageV2.Part {
  switch (part.type) {
    case "text":
      return {
        ...part,
        text: redact("text", part.id, part.text),
        metadata: data("text-metadata", part.id, part.metadata),
      }
    case "reasoning":
      return {
        ...part,
        text: redact("reasoning", part.id, part.text),
        metadata: data("reasoning-metadata", part.id, part.metadata),
      }
    case "file":
      return filepart(part)
    case "subtask":
      return {
        ...part,
        prompt: redact("subtask-prompt", part.id, part.prompt),
        description: redact("subtask-description", part.id, part.description),
        command: part.command === undefined ? undefined : redact("subtask-command", part.id, part.command),
      }
    case "tool":
      return {
        ...part,
        metadata: data("tool-metadata", part.id, part.metadata),
        state:
          part.state.status === "pending"
            ? {
                ...part.state,
                input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                raw: redact("tool-raw", part.id, part.state.raw),
              }
            : part.state.status === "running"
              ? {
                  ...part.state,
                  input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                  title: part.state.title === undefined ? undefined : redact("tool-title", part.id, part.state.title),
                  metadata: data("tool-state-metadata", part.id, part.state.metadata),
                }
              : part.state.status === "completed"
                ? {
                    ...part.state,
                    input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                    output: redact("tool-output", part.id, part.state.output),
                    title: redact("tool-title", part.id, part.state.title),
                    metadata: data("tool-state-metadata", part.id, part.state.metadata) ?? part.state.metadata,
                    attachments: part.state.attachments?.map(filepart),
                  }
                : {
                    ...part.state,
                    input: data("tool-input", part.id, part.state.input) ?? part.state.input,
                    metadata: data("tool-state-metadata", part.id, part.state.metadata),
                  },
      }
    case "patch":
      return {
        ...part,
        hash: redact("patch", part.id, part.hash),
        files: part.files.map((item, i) => redact("patch-file", `${part.id}-${i}`, item)),
      }
    case "snapshot":
      return {
        ...part,
        snapshot: redact("snapshot", part.id, part.snapshot),
      }
    case "step-start":
      return {
        ...part,
        snapshot: part.snapshot === undefined ? undefined : redact("snapshot", part.id, part.snapshot),
      }
    case "step-finish":
      return {
        ...part,
        snapshot: part.snapshot === undefined ? undefined : redact("snapshot", part.id, part.snapshot),
      }
    case "agent":
      return {
        ...part,
        source: !part.source
          ? part.source
          : {
              ...part.source,
              value: redact("agent-source", part.id, part.source.value),
            },
      }
    default:
      return part
  }
}

function sanitize(input: { info: Session.Info; messages: MessageV2.WithParts[] }) {
  return {
    info: {
      ...input.info,
      title: redact("session-title", input.info.id, input.info.title),
      directory: redact("session-directory", input.info.id, input.info.directory),
      summary: !input.info.summary
        ? input.info.summary
        : {
            ...input.info.summary,
            diffs: diff("session-diff", input.info.summary.diffs),
          },
      revert: !input.info.revert
        ? input.info.revert
        : {
            ...input.info.revert,
            snapshot:
              input.info.revert.snapshot === undefined
                ? undefined
                : redact("revert-snapshot", input.info.id, input.info.revert.snapshot),
            diff:
              input.info.revert.diff === undefined
                ? undefined
                : redact("revert-diff", input.info.id, input.info.revert.diff),
          },
    },
    messages: input.messages.map((msg) => ({
      info:
        msg.info.role === "user"
          ? {
              ...msg.info,
              system: msg.info.system === undefined ? undefined : redact("system", msg.info.id, msg.info.system),
              summary: !msg.info.summary
                ? msg.info.summary
                : {
                    ...msg.info.summary,
                    title:
                      msg.info.summary.title === undefined
                        ? undefined
                        : redact("summary-title", msg.info.id, msg.info.summary.title),
                    body:
                      msg.info.summary.body === undefined
                        ? undefined
                        : redact("summary-body", msg.info.id, msg.info.summary.body),
                    diffs: diff("message-diff", msg.info.summary.diffs),
                  },
            }
          : {
              ...msg.info,
              path: {
                cwd: redact("cwd", msg.info.id, msg.info.path.cwd),
                root: redact("root", msg.info.id, msg.info.path.root),
              },
            },
      parts: msg.parts.map(part),
    })),
  }
}

export * as SessionArchive from "./archive"
