import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { resolveConversationDirectoryPaths } from "../conversation-directories.js";
import * as schema from "../schema.js";
import { migrationSteps } from "../steps.js";
import { migrateMaterializeHistoricalInlineMessageMedia } from "./351-materialize-historical-inline-message-media.js";
import { runMigrationSteps } from "./run-migrations.js";

const tempDirs: string[] = [];
const DEFAULT_CONVERSATION_ID = "conversation-test";
const DEFAULT_CONVERSATION_CREATED_AT = 1000;

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    PRAGMA foreign_keys = ON;
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      finalized INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      original_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      kind TEXT NOT NULL,
      data_base64 TEXT NOT NULL,
      content_hash TEXT,
      thumbnail_base64 TEXT,
      file_path TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_attachments_content_dedup
      ON attachments(content_hash) WHERE content_hash IS NOT NULL;
    CREATE TABLE message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  const workspaceDir = mkdtempSync(join(tmpdir(), "inline-media-"));
  tempDirs.push(workspaceDir);
  const attachmentsDirFor = (
    conversationId: string,
    conversationCreatedAt: number,
  ): string =>
    join(
      resolveConversationDirectoryPaths(
        conversationId,
        conversationCreatedAt,
        workspaceDir,
      ).resolvedDirPath,
      "attachments",
    );
  const attachmentsDir = attachmentsDirFor(
    DEFAULT_CONVERSATION_ID,
    DEFAULT_CONVERSATION_CREATED_AT,
  );
  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    workspaceDir,
    attachmentsDir,
    attachmentsDirFor,
    options: {
      resolveAttachmentsDir: attachmentsDirFor,
      yieldToEventLoop: async () => {},
    },
  };
}

function insertMessage(
  sqlite: Database,
  id: string,
  content: unknown,
  finalized = 1,
  conversationId = DEFAULT_CONVERSATION_ID,
  conversationCreatedAt = DEFAULT_CONVERSATION_CREATED_AT,
): void {
  sqlite
    .query(`INSERT OR IGNORE INTO conversations (id, created_at) VALUES (?, ?)`)
    .run(conversationId, conversationCreatedAt);
  sqlite
    .query(
      `INSERT INTO messages (
         id, conversation_id, content, created_at, finalized
       ) VALUES (?, ?, ?, 1234, ?)`,
    )
    .run(
      id,
      conversationId,
      typeof content === "string" ? content : JSON.stringify(content),
      finalized,
    );
}

function messageContent(sqlite: Database, id: string): unknown {
  const row = sqlite
    .query(`SELECT content FROM messages WHERE id = ?`)
    .get(id) as { content: string };
  return JSON.parse(row.content);
}

function count(sqlite: Database, table: string): number {
  return (
    sqlite.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }
  ).count;
}

function historicalAttachmentId(
  messageId: string,
  path: string,
  bytes: Buffer,
): string {
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const identityHash = createHash("sha256")
    .update(`${messageId}\0${path}\0${contentHash}`)
    .digest("hex");
  return `historical-inline-media-${identityHash}`;
}

function insertAttachment(
  sqlite: Database,
  id: string,
  dataBase64: string,
  filePath: string | null = null,
): void {
  sqlite
    .query(
      `INSERT INTO attachments (
         id, original_filename, mime_type, size_bytes, kind, data_base64,
         content_hash, thumbnail_base64, file_path, created_at
       ) VALUES (?, 'existing.bin', 'application/octet-stream', ?, 'document', ?, NULL, NULL, ?, 1000)`,
    )
    .run(id, Buffer.from(dataBase64, "base64").length, dataBase64, filePath);
}

function linkAttachment(
  sqlite: Database,
  messageId: string,
  attachmentId: string,
  position: number,
): void {
  sqlite
    .query(
      `INSERT INTO message_attachments (
         id, message_id, attachment_id, position, created_at
       ) VALUES (?, ?, ?, ?, 1000)`,
    )
    .run(
      `link-${messageId}-${attachmentId}`,
      messageId,
      attachmentId,
      position,
    );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("migration 351: materialize historical inline message media", () => {
  test("is registered as its own checkpointed migration step", () => {
    const step = migrationSteps.find(
      (candidate) =>
        typeof candidate !== "function" &&
        candidate.name === "migrateMaterializeHistoricalInlineMessageMedia",
    );
    expect(step).toBeDefined();
    expect(typeof step !== "function" ? step?.run : undefined).toBe(
      migrateMaterializeHistoricalInlineMessageMedia,
    );
  });

  test("materializes root and nested image/file blocks with stable links and metadata", async () => {
    const { sqlite, db, options } = createTestDb();
    const imageOne = Buffer.from("image-one").toString("base64");
    const fileOne = Buffer.from("file-one").toString("base64");
    const imageTwo = Buffer.from("image-two").toString("base64");
    const fileTwo = Buffer.from("file-two").toString("base64");
    const webFile = Buffer.from("web-file").toString("base64");
    insertMessage(sqlite, "message-1", [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: imageOne,
          custom: "preserved",
        },
        blockMetadata: true,
      },
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "text/plain",
          data: fileOne,
          filename: "notes.txt",
        },
        extracted_text: "notes",
      },
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "generated media",
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: imageTwo,
            },
          },
          {
            type: "file",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: fileTwo,
              filename: "report.pdf",
            },
          },
        ],
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "search-1",
        content: [],
        contentBlocks: [
          {
            type: "file",
            source: {
              type: "base64",
              media_type: "text/plain",
              data: webFile,
              filename: "result.txt",
            },
          },
        ],
      },
    ]);

    await migrateMaterializeHistoricalInlineMessageMedia(db, options);

    const content = messageContent(sqlite, "message-1") as Array<any>;
    const converted = [
      content[0],
      content[1],
      content[2].contentBlocks[0],
      content[2].contentBlocks[1],
      content[3].contentBlocks[0],
    ];
    expect(converted.map((block) => block.source.type)).toEqual([
      "workspace_ref",
      "workspace_ref",
      "workspace_ref",
      "workspace_ref",
      "workspace_ref",
    ]);
    expect(converted.map((block) => block.source.sizeBytes)).toEqual([
      9, 8, 9, 8, 8,
    ]);
    expect(content[0].source.custom).toBe("preserved");
    expect(content[0].blockMetadata).toBe(true);
    expect(content[1].source.filename).toBe("notes.txt");
    expect(content[1].extracted_text).toBe("notes");
    expect(content[2].contentBlocks[1].source.filename).toBe("report.pdf");
    expect(content[3].contentBlocks[0].source.filename).toBe("result.txt");
    expect(count(sqlite, "attachments")).toBe(5);
    expect(count(sqlite, "message_attachments")).toBe(5);
    const positions = (
      sqlite
        .query(
          `SELECT position FROM message_attachments
           WHERE message_id = 'message-1' ORDER BY position`,
        )
        .all() as Array<{ position: number }>
    ).map((row) => row.position);
    expect(positions).toEqual([0, 1, 2, 3, 4]);
    for (const block of converted) {
      const row = sqlite
        .query(
          `SELECT file_path AS filePath, content_hash AS contentHash FROM attachments WHERE id = ?`,
        )
        .get(block.source.attachmentId) as {
        filePath: string;
        contentHash: string | null;
      };
      expect(existsSync(row.filePath)).toBe(true);
      expect(row.contentHash).toBeNull();
    }
  });

  test("reuses same-message references and exact linked media without inferring by position", async () => {
    const { sqlite, db, options } = createTestDb();
    const fileData = Buffer.from("known-file").toString("base64");
    const imageData = Buffer.from("known-image").toString("base64");
    const unrelatedData = Buffer.from("unrelated").toString("base64");
    insertMessage(sqlite, "message-2", [
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "application/octet-stream",
          data: fileData,
          filename: "known.bin",
        },
        _attachmentId: "attachment-file",
      },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: imageData,
        },
      },
      {
        type: "image",
        source: {
          type: "workspace_ref",
          media_type: "image/png",
          attachmentId: "already-referenced",
          sizeBytes: 10,
        },
      },
    ]);
    insertAttachment(sqlite, "attachment-unrelated", unrelatedData);
    insertAttachment(sqlite, "attachment-file", fileData);
    insertAttachment(sqlite, "attachment-image", imageData);
    linkAttachment(sqlite, "message-2", "attachment-unrelated", 0);
    linkAttachment(sqlite, "message-2", "attachment-file", 4);
    linkAttachment(sqlite, "message-2", "attachment-image", 7);

    await migrateMaterializeHistoricalInlineMessageMedia(db, options);

    const content = messageContent(sqlite, "message-2") as Array<any>;
    expect(content[0].source.attachmentId).toBe("attachment-file");
    expect(content[0]._attachmentId).toBeUndefined();
    expect(content[1].source.attachmentId).toBe("attachment-image");
    expect(content[2].source.attachmentId).toBe("already-referenced");
    expect(count(sqlite, "attachments")).toBe(3);
    expect(count(sqlite, "message_attachments")).toBe(3);
  });

  test("materializes the inline bytes when a legacy attachment ID points at different media", async () => {
    const { sqlite, db, options } = createTestDb();
    const inlineBytes = Buffer.from("correct-media");
    insertMessage(sqlite, "message-stale-link", [
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "application/octet-stream",
          data: inlineBytes.toString("base64"),
          filename: "correct.bin",
        },
        _attachmentId: "attachment-stale",
      },
    ]);
    insertAttachment(
      sqlite,
      "attachment-stale",
      Buffer.from("wrong-media").toString("base64"),
    );
    linkAttachment(sqlite, "message-stale-link", "attachment-stale", 0);

    await migrateMaterializeHistoricalInlineMessageMedia(db, options);

    const content = messageContent(sqlite, "message-stale-link") as Array<any>;
    const recoveredId = content[0].source.attachmentId as string;
    expect(recoveredId.startsWith("historical-inline-media-")).toBe(true);
    expect(recoveredId).not.toBe("attachment-stale");
    expect(content[0]._attachmentId).toBeUndefined();
    const recovered = sqlite
      .query(`SELECT file_path AS filePath FROM attachments WHERE id = ?`)
      .get(recoveredId) as { filePath: string };
    expect(readFileSync(recovered.filePath)).toEqual(inlineBytes);
    expect(count(sqlite, "attachments")).toBe(2);
    expect(count(sqlite, "message_attachments")).toBe(2);
  });

  test("is idempotent across rows, links, and files", async () => {
    const { sqlite, db, options, attachmentsDir } = createTestDb();
    insertMessage(sqlite, "message-3", [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from("same-image").toString("base64"),
        },
      },
    ]);

    await migrateMaterializeHistoricalInlineMessageMedia(db, options);
    const firstContent = JSON.stringify(messageContent(sqlite, "message-3"));
    const firstFiles = readdirSync(attachmentsDir).sort();
    await migrateMaterializeHistoricalInlineMessageMedia(db, options);

    expect(JSON.stringify(messageContent(sqlite, "message-3"))).toBe(
      firstContent,
    );
    expect(count(sqlite, "attachments")).toBe(1);
    expect(count(sqlite, "message_attachments")).toBe(1);
    expect(readdirSync(attachmentsDir).sort()).toEqual(firstFiles);
  });

  test("stores files under independently removable conversation directories", async () => {
    const { sqlite, db, options, attachmentsDirFor, workspaceDir } =
      createTestDb();
    const insertInlineFile = (
      messageId: string,
      conversationId: string,
      conversationCreatedAt: number,
    ): void => {
      insertMessage(
        sqlite,
        messageId,
        [
          {
            type: "file",
            source: {
              type: "base64",
              media_type: "text/plain",
              data: Buffer.from(messageId).toString("base64"),
              filename: `${messageId}.txt`,
            },
          },
        ],
        1,
        conversationId,
        conversationCreatedAt,
      );
    };
    insertInlineFile("message-a", "conversation-a", 1000);
    insertInlineFile("message-b", "conversation-b", 2000);

    await migrateMaterializeHistoricalInlineMessageMedia(db, options);

    const rows = sqlite
      .query(
        `SELECT m.conversation_id AS conversationId, a.file_path AS filePath
         FROM message_attachments ma
         JOIN messages m ON m.id = ma.message_id
         JOIN attachments a ON a.id = ma.attachment_id
         ORDER BY m.conversation_id`,
      )
      .all() as Array<{ conversationId: string; filePath: string }>;
    const attachmentsDirA = attachmentsDirFor("conversation-a", 1000);
    const attachmentsDirB = attachmentsDirFor("conversation-b", 2000);
    expect(rows[0].filePath.startsWith(`${attachmentsDirA}${sep}`)).toBe(true);
    expect(rows[1].filePath.startsWith(`${attachmentsDirB}${sep}`)).toBe(true);

    const conversationDirA = resolveConversationDirectoryPaths(
      "conversation-a",
      1000,
      workspaceDir,
    ).resolvedDirPath;
    rmSync(conversationDirA, {
      recursive: true,
      force: true,
    });
    expect(existsSync(rows[0].filePath)).toBe(false);
    expect(existsSync(rows[1].filePath)).toBe(true);
  });

  test("rejects path-traversal-shaped conversation IDs before writing files", async () => {
    const { sqlite, db, options, workspaceDir } = createTestDb();
    insertMessage(
      sqlite,
      "message-unsafe-conversation",
      [
        {
          type: "file",
          source: {
            type: "base64",
            media_type: "text/plain",
            data: Buffer.from("unsafe").toString("base64"),
          },
        },
      ],
      1,
      "../outside",
      1000,
    );

    expect(
      migrateMaterializeHistoricalInlineMessageMedia(db, options),
    ).rejects.toThrow("unsafe conversation ID");
    expect(readdirSync(workspaceDir)).toEqual([]);
    expect(count(sqlite, "attachments")).toBe(0);
    expect(count(sqlite, "message_attachments")).toBe(0);
  });

  test("reuses a verified deterministic row left without its message link", async () => {
    const { sqlite, db, options, attachmentsDir } = createTestDb();
    const bytes = Buffer.from("pre-existing-media");
    const data = bytes.toString("base64");
    const attachmentId = historicalAttachmentId("message-recovery", "0", bytes);
    const filePath = join(attachmentsDir, attachmentId);
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(filePath, bytes);
    insertMessage(sqlite, "message-recovery", [
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "text/plain",
          data,
          filename: "recovery.txt",
        },
      },
    ]);
    insertAttachment(sqlite, attachmentId, "", filePath);

    await migrateMaterializeHistoricalInlineMessageMedia(db, options);

    const content = messageContent(sqlite, "message-recovery") as Array<any>;
    expect(content[0].source.attachmentId).toBe(attachmentId);
    expect(count(sqlite, "attachments")).toBe(1);
    expect(count(sqlite, "message_attachments")).toBe(1);
    expect(readdirSync(attachmentsDir)).toEqual([attachmentId]);
  });

  test("rejects a deterministic row whose stored path conflicts with its identity", async () => {
    const { sqlite, db, options, attachmentsDir } = createTestDb();
    const bytes = Buffer.from("conflicting-media");
    const data = bytes.toString("base64");
    const attachmentId = historicalAttachmentId("message-conflict", "0", bytes);
    const alternatePath = join(attachmentsDir, "alternate-file");
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(alternatePath, bytes);
    insertMessage(sqlite, "message-conflict", [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data,
        },
      },
    ]);
    insertAttachment(sqlite, attachmentId, "", alternatePath);

    expect(
      migrateMaterializeHistoricalInlineMessageMedia(db, options),
    ).rejects.toThrow("conflicts with deterministic identity");
    expect(
      (messageContent(sqlite, "message-conflict") as Array<any>)[0].source.type,
    ).toBe("base64");
    expect(count(sqlite, "message_attachments")).toBe(0);
  });

  test("leaves malformed JSON, invalid base64, and unfinalized rows untouched", async () => {
    const { sqlite, db, options, attachmentsDir } = createTestDb();
    insertMessage(sqlite, "malformed-json", "{not-json");
    insertMessage(sqlite, "invalid-base64", [
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "text/plain",
          data: "not base64!",
          filename: "bad.txt",
        },
      },
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "text/plain",
          data: "abcd==",
          filename: "bad-padding.txt",
        },
      },
    ]);
    insertMessage(
      sqlite,
      "unfinalized",
      [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: Buffer.from("pending").toString("base64"),
          },
        },
      ],
      0,
    );
    const before = sqlite
      .query(`SELECT id, content FROM messages ORDER BY id`)
      .all();

    await migrateMaterializeHistoricalInlineMessageMedia(db, options);

    expect(
      sqlite.query(`SELECT id, content FROM messages ORDER BY id`).all(),
    ).toEqual(before);
    expect(count(sqlite, "attachments")).toBe(0);
    expect(count(sqlite, "message_attachments")).toBe(0);
    expect(existsSync(attachmentsDir)).toBe(false);
  });

  test("leaves a valid media write failure uncheckpointed without changing database state", async () => {
    const { sqlite, db, options } = createTestDb();
    const content = [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from("valid-image").toString("base64"),
        },
      },
    ];
    insertMessage(sqlite, "message-4", content);

    const result = await runMigrationSteps(db, [
      {
        name: "migrateMaterializeHistoricalInlineMessageMedia",
        run: (migrationDb) =>
          migrateMaterializeHistoricalInlineMessageMedia(migrationDb, {
            ...options,
            writeFile: () => {
              throw new Error("disk unavailable");
            },
          }),
      },
    ]);

    expect(result.failed).toEqual([
      "migrateMaterializeHistoricalInlineMessageMedia",
    ]);
    expect(
      (
        sqlite
          .query(
            `SELECT value FROM memory_checkpoints
             WHERE key = 'step:migrateMaterializeHistoricalInlineMessageMedia'`,
          )
          .get() as { value: string }
      ).value,
    ).toBe("started");
    expect(messageContent(sqlite, "message-4")).toEqual(content);
    expect(count(sqlite, "attachments")).toBe(0);
    expect(count(sqlite, "message_attachments")).toBe(0);
  });

  test("rolls back database writes and reuses the deterministic file after interruption", async () => {
    const { sqlite, db, options, attachmentsDir } = createTestDb();
    insertMessage(sqlite, "message-5", [
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "text/plain",
          data: Buffer.from("recoverable").toString("base64"),
          filename: "recover.txt",
        },
      },
    ]);
    sqlite.exec(/*sql*/ `
      CREATE TRIGGER fail_message_rewrite
      BEFORE UPDATE ON messages
      BEGIN
        SELECT RAISE(ABORT, 'interrupted');
      END;
    `);

    expect(
      migrateMaterializeHistoricalInlineMessageMedia(db, options),
    ).rejects.toThrow("interrupted");
    expect(count(sqlite, "attachments")).toBe(0);
    expect(count(sqlite, "message_attachments")).toBe(0);
    expect(readdirSync(attachmentsDir)).toHaveLength(1);

    sqlite.exec(`DROP TRIGGER fail_message_rewrite`);
    await migrateMaterializeHistoricalInlineMessageMedia(db, options);

    const content = messageContent(sqlite, "message-5") as Array<any>;
    expect(content[0].source.type).toBe("workspace_ref");
    expect(count(sqlite, "attachments")).toBe(1);
    expect(count(sqlite, "message_attachments")).toBe(1);
    expect(readdirSync(attachmentsDir)).toHaveLength(1);
  });
});
