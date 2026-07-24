import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { rebuildHistoricalInlineMediaDiskViewMigration } from "../workspace/migrations/134-rebuild-historical-inline-media-disk-view.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import {
  loadCheckpoints,
  runWorkspaceMigrations,
} from "../workspace/migrations/runner.js";
import { assertNotLiveDb } from "./assert-not-live-db.js";

let workspaceDir: string;
let db: Database;

function conversationDir(id: string, createdAt: number): string {
  return join(
    workspaceDir,
    "conversations",
    `${new Date(createdAt).toISOString().replace(/:/g, "-")}_${id}`,
  );
}

function seedConversation(options?: {
  conversationId?: string;
  attachmentId?: string;
  attachmentBytes?: Buffer | null;
}): { attachmentPath: string; messagesPath: string } {
  const conversationId = options?.conversationId ?? "conversation-134";
  const attachmentId =
    options?.attachmentId ?? "historical-inline-media-attachment-134";
  const attachmentBytes =
    options?.attachmentBytes === undefined
      ? Buffer.from("historical attachment")
      : options.attachmentBytes;
  const createdAt = 1_700_000_000_000;
  const dir = conversationDir(conversationId, createdAt);
  const attachmentsDir = join(dir, "attachments");
  const attachmentPath = join(attachmentsDir, attachmentId);
  const messagesPath = join(dir, "messages.jsonl");
  mkdirSync(attachmentsDir, { recursive: true });
  if (attachmentBytes) {
    writeFileSync(attachmentPath, attachmentBytes);
  }
  writeFileSync(messagesPath, '{"role":"user","content":"stale"}\n');

  db.query(
    `INSERT INTO conversations (
       id, title, created_at, updated_at, conversation_type, origin_channel
     ) VALUES (?, 'Example conversation', ?, ?, 'standard', 'desktop')`,
  ).run(conversationId, createdAt, createdAt + 1);
  db.query(
    `INSERT INTO messages (
       id, conversation_id, role, content, created_at, metadata, finalized
     ) VALUES (?, ?, 'user', ?, ?, '{"source":"example"}', 1)`,
  ).run(
    `message-${conversationId}`,
    conversationId,
    JSON.stringify([
      { type: "text", text: "Stored message" },
      {
        type: "file",
        source: {
          type: "workspace_ref",
          attachmentId,
          media_type: "text/plain",
          sizeBytes: attachmentBytes?.length ?? 0,
        },
      },
    ]),
    createdAt + 2,
  );
  db.query(
    `INSERT INTO attachments (
       id, original_filename, data_base64, file_path
     ) VALUES (?, 'example.txt', '', ?)`,
  ).run(attachmentId, attachmentPath);
  db.query(
    `INSERT INTO message_attachments (
       id, message_id, attachment_id, position
     ) VALUES (?, ?, ?, 0)`,
  ).run(`link-${conversationId}`, `message-${conversationId}`, attachmentId);

  return { attachmentPath, messagesPath };
}

function markDbMigrationComplete(value = "1"): void {
  db.query(
    `INSERT OR REPLACE INTO memory_checkpoints (key, value, updated_at)
     VALUES ('step:migrateMaterializeHistoricalInlineMessageMedia', ?, 1)`,
  ).run(value);
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "workspace-migration-134-"));
  const dbDir = join(workspaceDir, "data", "db");
  mkdirSync(dbDir, { recursive: true });
  db = new Database(join(dbDir, "assistant.db"));
  db.exec(/*sql*/ `
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      conversation_type TEXT NOT NULL,
      origin_channel TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      metadata TEXT,
      finalized INTEGER NOT NULL
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      original_filename TEXT NOT NULL,
      data_base64 TEXT NOT NULL,
      file_path TEXT
    );
    CREATE TABLE message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      position INTEGER NOT NULL
    );
  `);
});

afterEach(() => {
  db.close();
  assertNotLiveDb(workspaceDir);
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("workspace migration 134: historical inline-media disk view", () => {
  test("is registered last and retries failed checkpoints", () => {
    expect(WORKSPACE_MIGRATIONS.at(-1)).toBe(
      rebuildHistoricalInlineMediaDiskViewMigration,
    );
    expect(
      rebuildHistoricalInlineMediaDiskViewMigration.retryFailedCheckpoint,
    ).toBe(true);
  });

  test("defers until the database media migration is complete", () => {
    expect(() =>
      rebuildHistoricalInlineMediaDiskViewMigration.run(workspaceDir),
    ).toThrow("has not completed");
    markDbMigrationComplete("started");
    expect(() =>
      rebuildHistoricalInlineMediaDiskViewMigration.run(workspaceDir),
    ).toThrow("has not completed");
  });

  test("rebuilds only affected disk views and is idempotent", () => {
    markDbMigrationComplete();
    const target = seedConversation();
    const unaffected = seedConversation({
      conversationId: "conversation-unaffected",
      attachmentId: "existing-attachment",
    });

    rebuildHistoricalInlineMediaDiskViewMigration.run(workspaceDir);

    const rebuilt = readFileSync(target.messagesPath, "utf8");
    const record = JSON.parse(rebuilt.trim()) as Record<string, unknown>;
    expect(record).toMatchObject({
      role: "user",
      content: "Stored message",
      metadata: { source: "example" },
      attachments: ["historical-inline-media-attachment-134"],
    });
    expect(readFileSync(unaffected.messagesPath, "utf8")).toBe(
      '{"role":"user","content":"stale"}\n',
    );

    rebuildHistoricalInlineMediaDiskViewMigration.run(workspaceDir);

    expect(readFileSync(target.messagesPath, "utf8")).toBe(rebuilt);
    expect(existsSync(target.attachmentPath)).toBe(true);
  });

  test("folds file-backed message content while rebuilding the conversation", () => {
    markDbMigrationComplete();
    const target = seedConversation();
    const contentDir = join(workspaceDir, "conversations", "content");
    const contentPath = join(contentDir, "message.jsonl");
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(
      contentPath,
      [
        JSON.stringify({
          i: 0,
          seq: 1,
          block: { type: "text", text: "Older text" },
        }),
        JSON.stringify({
          i: 0,
          seq: 2,
          block: { type: "text", text: "File-backed text" },
        }),
      ].join("\n"),
    );
    db.query(
      `INSERT INTO messages (
         id, conversation_id, role, content, created_at, metadata, finalized
       ) VALUES ('message-file-backed', 'conversation-134', 'assistant', ?, ?, NULL, 1)`,
    ).run(
      JSON.stringify({ ref: "conversations/content/message.jsonl" }),
      1_700_000_000_010,
    );

    rebuildHistoricalInlineMediaDiskViewMigration.run(workspaceDir);

    const records = readFileSync(target.messagesPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      role: "assistant",
      content: "File-backed text",
    });
  });

  test("retries a failed projection after attachment storage recovers", async () => {
    markDbMigrationComplete();
    const target = seedConversation({ attachmentBytes: null });

    const failed = await runWorkspaceMigrations(workspaceDir, [
      rebuildHistoricalInlineMediaDiskViewMigration,
    ]);

    expect(failed).toEqual({ applied: 0, skipped: 0, failed: 1 });
    expect(
      loadCheckpoints(workspaceDir).applied[
        rebuildHistoricalInlineMediaDiskViewMigration.id
      ]?.status,
    ).toBe("failed");

    writeFileSync(target.attachmentPath, "recovered");
    const retried = await runWorkspaceMigrations(workspaceDir, [
      rebuildHistoricalInlineMediaDiskViewMigration,
    ]);

    expect(retried).toEqual({ applied: 1, skipped: 0, failed: 0 });
    expect(
      loadCheckpoints(workspaceDir).applied[
        rebuildHistoricalInlineMediaDiskViewMigration.id
      ]?.status,
    ).toBe("completed");
    expect(
      JSON.parse(readFileSync(target.messagesPath, "utf8").trim()).attachments,
    ).toEqual(["historical-inline-media-attachment-134"]);
  });

  test("re-runs an interrupted started checkpoint", async () => {
    markDbMigrationComplete();
    const target = seedConversation();
    const checkpointPath = join(
      workspaceDir,
      "data",
      ".workspace-migrations.json",
    );
    writeFileSync(
      checkpointPath,
      JSON.stringify({
        applied: {
          [rebuildHistoricalInlineMediaDiskViewMigration.id]: {
            appliedAt: new Date(0).toISOString(),
            status: "started",
          },
        },
      }),
    );

    const result = await runWorkspaceMigrations(workspaceDir, [
      rebuildHistoricalInlineMediaDiskViewMigration,
    ]);

    expect(result).toEqual({ applied: 1, skipped: 0, failed: 0 });
    expect(
      JSON.parse(readFileSync(target.messagesPath, "utf8").trim()).attachments,
    ).toEqual(["historical-inline-media-attachment-134"]);
  });
});
