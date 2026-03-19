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
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must come before any imports that depend on them
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "workspace-migration-013-test-"));
const workspaceDir = join(testDir, "workspace");
const conversationsDir = join(workspaceDir, "conversations");
mkdirSync(conversationsDir, { recursive: true });

mock.module("../util/platform.js", () => ({
  getDataDir: () => join(workspaceDir, "data"),
  getWorkspaceDir: () => workspaceDir,
  getConversationsDir: () => conversationsDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
  getRootDir: () => testDir,
}));

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
import { getDb, initializeDb, rawRun, resetDb } from "../memory/db.js";
import {
  attachments,
  conversations,
  messageAttachments,
  messages,
} from "../memory/schema.js";
import { repairConversationDiskViewMigration } from "../workspace/migrations/013-repair-conversation-disk-view.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
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
  attachmentId: string;
  conversationId: string;
  conversationCreatedAt: number;
  conversationUpdatedAt: number;
} {
  const db = getDb();
  const conversationId = "conv-013-repair";
  const messageId = "msg-013-repair";
  const attachmentId = "att-013-repair";
  const conversationCreatedAt = Date.parse("2026-03-18T16:00:00.000Z");
  const messageCreatedAt = Date.parse("2026-03-18T16:01:00.000Z");
  const conversationUpdatedAt = Date.parse("2026-03-18T16:02:00.000Z");

  db.insert(conversations)
    .values({
      id: conversationId,
      title: "Repair Test",
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
      content: "Repair missing disk view",
      createdAt: messageCreatedAt,
      metadata: null,
    })
    .run();

  db.insert(attachments)
    .values({
      id: attachmentId,
      originalFilename: "transcript.txt",
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
      id: "link-013-repair",
      messageId,
      attachmentId,
      position: 0,
      createdAt: messageCreatedAt,
    })
    .run();

  return {
    attachmentId,
    conversationId,
    conversationCreatedAt,
    conversationUpdatedAt,
  };
}

function toConversationTimestamp(createdAtMs: number): string {
  return new Date(createdAtMs).toISOString().replace(/:/g, "-");
}

describe("013-repair-conversation-disk-view migration", () => {
  beforeEach(() => {
    resetTables();
    resetConversationsDir();
  });

  test("repairs missing disk-view folders and remains idempotent on rerun", () => {
    const { conversationId, conversationCreatedAt, conversationUpdatedAt } =
      seedConversationRows();
    const timestamp = toConversationTimestamp(conversationCreatedAt);
    const expectedDirName = `${timestamp}_${conversationId}`;
    const expectedDirPath = join(conversationsDir, expectedDirName);
    const legacyDirPath = join(
      conversationsDir,
      `${conversationId}_${timestamp}`,
    );
    const metaPath = join(expectedDirPath, "meta.json");
    const messagesPath = join(expectedDirPath, "messages.jsonl");
    const attachmentsDir = join(expectedDirPath, "attachments");

    // Precondition: workspace has persisted rows but no projected disk-view dirs.
    expect(readdirSync(conversationsDir)).toEqual([]);

    repairConversationDiskViewMigration.run(workspaceDir);

    expect(readdirSync(conversationsDir).sort()).toEqual([expectedDirName]);
    expect(existsSync(legacyDirPath)).toBe(false);
    expect(existsSync(metaPath)).toBe(true);
    expect(existsSync(messagesPath)).toBe(true);
    expect(existsSync(join(attachmentsDir, "transcript.txt"))).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.id).toBe(conversationId);
    expect(meta.updatedAt).toBe(new Date(conversationUpdatedAt).toISOString());

    const firstRunMessages = readFileSync(messagesPath, "utf-8");
    expect(firstRunMessages.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(firstRunMessages.trim())).toEqual({
      role: "user",
      ts: "2026-03-18T16:01:00.000Z",
      content: "Repair missing disk view",
      attachments: ["transcript.txt"],
    });
    expect(readFileSync(join(attachmentsDir, "transcript.txt"), "utf-8")).toBe(
      "hello world",
    );

    repairConversationDiskViewMigration.run(workspaceDir);

    expect(readdirSync(conversationsDir).sort()).toEqual([expectedDirName]);
    expect(readFileSync(messagesPath, "utf-8")).toBe(firstRunMessages);
    expect(readdirSync(attachmentsDir).sort()).toEqual(["transcript.txt"]);
    expect(readFileSync(join(attachmentsDir, "transcript.txt"), "utf-8")).toBe(
      "hello world",
    );
  });

  test("rebuilds when meta.json matches updatedAt but messages and attachments are missing", () => {
    const { conversationId, conversationCreatedAt, conversationUpdatedAt } =
      seedConversationRows();
    const conversationDir = getConversationDirPath(
      conversationId,
      conversationCreatedAt,
    );
    const metaPath = join(conversationDir, "meta.json");
    const messagesPath = join(conversationDir, "messages.jsonl");
    const attachmentsDir = join(conversationDir, "attachments");

    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(
      metaPath,
      JSON.stringify(
        {
          id: conversationId,
          title: "Repair Test",
          type: "standard",
          channel: "desktop",
          createdAt: new Date(conversationCreatedAt).toISOString(),
          updatedAt: new Date(conversationUpdatedAt).toISOString(),
        },
        null,
        2,
      ) + "\n",
    );

    expect(existsSync(metaPath)).toBe(true);
    expect(existsSync(messagesPath)).toBe(false);
    expect(existsSync(attachmentsDir)).toBe(false);

    repairConversationDiskViewMigration.run(workspaceDir);

    expect(existsSync(messagesPath)).toBe(true);
    expect(existsSync(attachmentsDir)).toBe(true);
    expect(readFileSync(messagesPath, "utf-8").trim().split("\n")).toHaveLength(
      1,
    );
    expect(JSON.parse(readFileSync(messagesPath, "utf-8").trim())).toEqual({
      role: "user",
      ts: "2026-03-18T16:01:00.000Z",
      content: "Repair missing disk view",
      attachments: ["transcript.txt"],
    });
    expect(readdirSync(attachmentsDir).sort()).toEqual(["transcript.txt"]);
    expect(readFileSync(join(attachmentsDir, "transcript.txt"), "utf-8")).toBe(
      "hello world",
    );

    const firstRunMessages = readFileSync(messagesPath, "utf-8");
    repairConversationDiskViewMigration.run(workspaceDir);
    expect(readFileSync(messagesPath, "utf-8")).toBe(firstRunMessages);
    expect(readdirSync(attachmentsDir).sort()).toEqual(["transcript.txt"]);
  });

  test("converges duplicate legacy/canonical directories to canonical after repair rebuild", () => {
    const { conversationId, conversationCreatedAt, conversationUpdatedAt } =
      seedConversationRows();
    const timestamp = toConversationTimestamp(conversationCreatedAt);
    const canonicalDirName = `${timestamp}_${conversationId}`;
    const canonicalDirPath = join(conversationsDir, canonicalDirName);
    const legacyDirPath = join(
      conversationsDir,
      `${conversationId}_${timestamp}`,
    );
    const canonicalMessagesPath = join(canonicalDirPath, "messages.jsonl");
    const canonicalAttachmentsDir = join(canonicalDirPath, "attachments");

    mkdirSync(canonicalAttachmentsDir, { recursive: true });
    writeFileSync(
      join(canonicalDirPath, "meta.json"),
      JSON.stringify(
        {
          id: conversationId,
          title: "Repair Test",
          type: "standard",
          channel: "desktop",
          createdAt: new Date(conversationCreatedAt).toISOString(),
          updatedAt: new Date(conversationUpdatedAt - 1000).toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(canonicalMessagesPath, '{"role":"user","content":"stale"}\n');
    writeFileSync(join(canonicalAttachmentsDir, "stale.txt"), "stale");

    const legacyAttachmentsDir = join(legacyDirPath, "attachments");
    mkdirSync(legacyAttachmentsDir, { recursive: true });
    writeFileSync(join(legacyDirPath, "meta.json"), '{"legacy":true}\n');
    writeFileSync(join(legacyDirPath, "messages.jsonl"), '{"legacy":true}\n');
    writeFileSync(join(legacyAttachmentsDir, "legacy.txt"), "legacy");

    repairConversationDiskViewMigration.run(workspaceDir);

    expect(readdirSync(conversationsDir).sort()).toEqual([canonicalDirName]);
    expect(existsSync(canonicalDirPath)).toBe(true);
    expect(existsSync(legacyDirPath)).toBe(false);
    expect(
      JSON.parse(readFileSync(join(canonicalDirPath, "meta.json"), "utf-8"))
        .updatedAt,
    ).toBe(new Date(conversationUpdatedAt).toISOString());
    expect(
      readFileSync(canonicalMessagesPath, "utf-8").trim().split("\n"),
    ).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(canonicalMessagesPath, "utf-8").trim()),
    ).toEqual({
      role: "user",
      ts: "2026-03-18T16:01:00.000Z",
      content: "Repair missing disk view",
      attachments: ["transcript.txt"],
    });
    expect(readdirSync(canonicalAttachmentsDir).sort()).toEqual([
      "transcript.txt",
    ]);
    expect(
      readFileSync(join(canonicalAttachmentsDir, "transcript.txt"), "utf-8"),
    ).toBe("hello world");
  });

  test("preserves compacted attachment files while pruning stale projected files during repair", () => {
    const {
      attachmentId,
      conversationId,
      conversationCreatedAt,
      conversationUpdatedAt,
    } = seedConversationRows();
    const conversationDir = getConversationDirPath(
      conversationId,
      conversationCreatedAt,
    );
    const messagesPath = join(conversationDir, "messages.jsonl");
    const attachmentsDir = join(conversationDir, "attachments");
    const transcriptPath = join(attachmentsDir, "transcript.txt");
    const stalePath = join(attachmentsDir, "stale.txt");

    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(
      join(conversationDir, "meta.json"),
      JSON.stringify(
        {
          id: conversationId,
          title: "Repair Test",
          type: "standard",
          channel: "desktop",
          createdAt: new Date(conversationCreatedAt).toISOString(),
          updatedAt: new Date(conversationUpdatedAt - 1000).toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(messagesPath, '{"role":"user","content":"stale"}\n');
    writeFileSync(transcriptPath, "hello world");
    writeFileSync(stalePath, "stale");

    rawRun(
      `UPDATE attachments
       SET data_base64 = '', file_path = ?, source_path = NULL
       WHERE id = ?`,
      transcriptPath,
      attachmentId,
    );

    repairConversationDiskViewMigration.run(workspaceDir);

    expect(readFileSync(transcriptPath, "utf-8")).toBe("hello world");
    expect(existsSync(stalePath)).toBe(false);
    expect(JSON.parse(readFileSync(messagesPath, "utf-8").trim())).toEqual({
      role: "user",
      ts: "2026-03-18T16:01:00.000Z",
      content: "Repair missing disk view",
      attachments: ["transcript.txt"],
    });
  });
});
