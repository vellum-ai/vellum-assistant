import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must come before any imports that depend on them
// ---------------------------------------------------------------------------

const testDir = process.env.VELLUM_WORKSPACE_DIR!;
const workspaceDir = testDir;
const conversationsDir = join(workspaceDir, "conversations");
mkdirSync(conversationsDir, { recursive: true });

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { getConversationDirPath } from "../memory/conversation-disk-view.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  attachments,
  conversations,
  messageAttachments,
  messages,
} from "../memory/schema.js";
import { backfillConversationDiskViewMigration } from "../workspace/migrations/009-backfill-conversation-disk-view.js";

initializeDb();

afterAll(() => {
  resetDb();
});

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function resetConversationsDir() {
  rmSync(conversationsDir, { recursive: true, force: true });
  mkdirSync(conversationsDir, { recursive: true });
}

function seedConversationRows(): {
  conversationId: string;
  conversationCreatedAt: number;
  conversationUpdatedAt: number;
} {
  const db = getDb();
  const conversationId = "conv-009-backfill";
  const messageId = "msg-009-backfill";
  const attachmentId = "att-009-backfill";
  const conversationCreatedAt = Date.parse("2026-03-18T14:23:00.000Z");
  const messageCreatedAt = Date.parse("2026-03-18T14:24:00.000Z");
  const conversationUpdatedAt = Date.parse("2026-03-18T14:25:00.000Z");

  db.insert(conversations)
    .values({
      id: conversationId,
      title: "Backfill Test",
      createdAt: conversationCreatedAt,
      updatedAt: conversationUpdatedAt,
      conversationType: "standard",
      source: "user",
      memoryScopeId: "default",
      originChannel: "desktop",
    })
    .run();

  db.insert(messages)
    .values({
      id: messageId,
      conversationId,
      role: "user",
      content: "Hello from sqlite row",
      createdAt: messageCreatedAt,
      metadata: null,
    })
    .run();

  db.insert(attachments)
    .values({
      id: attachmentId,
      originalFilename: "note.txt",
      mimeType: "text/plain",
      sizeBytes: 11,
      kind: "document",
      dataBase64: Buffer.from("hello world").toString("base64"),
      contentHash: null,
      thumbnailBase64: null,
      filePath: null,
      createdAt: messageCreatedAt,
    })
    .run();

  db.insert(messageAttachments)
    .values({
      id: "link-009-backfill",
      messageId,
      attachmentId,
      position: 0,
      createdAt: messageCreatedAt,
    })
    .run();

  return { conversationId, conversationCreatedAt, conversationUpdatedAt };
}

function toConversationTimestamp(createdAtMs: number): string {
  return new Date(createdAtMs).toISOString().replace(/:/g, "-");
}

describe("009-backfill-conversation-disk-view migration", () => {
  beforeEach(() => {
    resetTables();
    resetConversationsDir();
  });

  test("materializes disk view from sqlite-only rows and stays idempotent on rerun", () => {
    const { conversationId, conversationCreatedAt, conversationUpdatedAt } =
      seedConversationRows();
    const conversationDir = getConversationDirPath(
      conversationId,
      conversationCreatedAt,
    );
    const metaPath = join(conversationDir, "meta.json");
    const messagesPath = join(conversationDir, "messages.jsonl");
    const attachmentsDir = join(conversationDir, "attachments");

    // Precondition: only SQLite rows exist, disk view has not been created yet.
    expect(existsSync(conversationDir)).toBe(false);

    backfillConversationDiskViewMigration.run(workspaceDir);

    expect(existsSync(conversationDir)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);
    expect(existsSync(messagesPath)).toBe(true);
    expect(existsSync(join(attachmentsDir, "note.txt"))).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.id).toBe(conversationId);
    expect(meta.updatedAt).toBe(new Date(conversationUpdatedAt).toISOString());

    const firstRunLines = readFileSync(messagesPath, "utf-8")
      .trim()
      .split("\n");
    expect(firstRunLines).toHaveLength(1);
    expect(JSON.parse(firstRunLines[0])).toEqual({
      role: "user",
      ts: "2026-03-18T14:24:00.000Z",
      content: "Hello from sqlite row",
      attachments: ["note.txt"],
    });

    backfillConversationDiskViewMigration.run(workspaceDir);

    const secondRunLines = readFileSync(messagesPath, "utf-8")
      .trim()
      .split("\n");
    expect(secondRunLines).toHaveLength(1);
    expect(JSON.parse(secondRunLines[0])).toEqual(JSON.parse(firstRunLines[0]));

    const attachmentFiles = readdirSync(attachmentsDir).sort();
    expect(attachmentFiles).toEqual(["note.txt"]);
    expect(readFileSync(join(attachmentsDir, "note.txt"), "utf-8")).toBe(
      "hello world",
    );
  });

  test("rebuilds stale legacy-named disk views in-place and stays idempotent", () => {
    const { conversationId, conversationCreatedAt, conversationUpdatedAt } =
      seedConversationRows();
    const timestamp = toConversationTimestamp(conversationCreatedAt);
    const expectedNewDirName = `${timestamp}_${conversationId}`;
    const expectedNewDirPath = join(conversationsDir, expectedNewDirName);
    const legacyDirPath = join(
      conversationsDir,
      `${conversationId}_${timestamp}`,
    );
    const metaPath = join(legacyDirPath, "meta.json");
    const messagesPath = join(legacyDirPath, "messages.jsonl");
    const attachmentsDir = join(legacyDirPath, "attachments");

    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(
      metaPath,
      JSON.stringify(
        {
          id: conversationId,
          title: "Backfill Test",
          type: "standard",
          channel: "desktop",
          createdAt: new Date(conversationCreatedAt).toISOString(),
          updatedAt: new Date(conversationUpdatedAt - 1000).toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(messagesPath, '{"role":"user","content":"stale line"}\n');
    writeFileSync(join(attachmentsDir, "stale.txt"), "stale");

    backfillConversationDiskViewMigration.run(workspaceDir);

    expect(existsSync(expectedNewDirPath)).toBe(false);
    expect(existsSync(legacyDirPath)).toBe(true);
    expect(JSON.parse(readFileSync(metaPath, "utf-8")).updatedAt).toBe(
      new Date(conversationUpdatedAt).toISOString(),
    );
    expect(readFileSync(messagesPath, "utf-8").trim().split("\n")).toHaveLength(
      1,
    );
    expect(JSON.parse(readFileSync(messagesPath, "utf-8").trim())).toEqual({
      role: "user",
      ts: "2026-03-18T14:24:00.000Z",
      content: "Hello from sqlite row",
      attachments: ["note.txt"],
    });
    expect(readdirSync(attachmentsDir).sort()).toEqual(["note.txt"]);
    expect(readFileSync(join(attachmentsDir, "note.txt"), "utf-8")).toBe(
      "hello world",
    );

    const firstRunMessages = readFileSync(messagesPath, "utf-8");
    backfillConversationDiskViewMigration.run(workspaceDir);

    expect(readFileSync(messagesPath, "utf-8")).toBe(firstRunMessages);
    expect(readdirSync(attachmentsDir).sort()).toEqual(["note.txt"]);
  });
});
