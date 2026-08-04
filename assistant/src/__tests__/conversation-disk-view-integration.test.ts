/**
 * Integration tests for the ConversationDiskView lifecycle hooks.
 *
 * Verifies that creating, messaging, updating titles, deleting, and clearing
 * conversations correctly projects to the disk-view filesystem layout.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

const workspaceDir = process.env.VELLUM_WORKSPACE_DIR!;
const conversationsDir = join(workspaceDir, "conversations");
mkdirSync(conversationsDir, { recursive: true });

import {
  linkAttachmentToMessage,
  uploadAttachment,
} from "../persistence/attachments-store.js";
import {
  addMessage,
  clearAll,
  createConversation,
  deleteConversation,
  updateConversationTitle,
  updateMessageContent,
} from "../persistence/conversation-crud.js";
import {
  getConversationDirPath,
  syncMessageToDisk,
} from "../persistence/conversation-disk-view.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
await initializeDb();

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

// ---------------------------------------------------------------------------
// Lifecycle integration: createConversation
// ---------------------------------------------------------------------------

describe("createConversation → disk view", () => {
  beforeEach(() => {
    resetTables();
    resetConversationsDir();
  });

  test("creates directory and meta.json on createConversation", () => {
    const conv = createConversation("My Conversation");

    const dirPath = getConversationDirPath(conv.id, conv.createdAt);
    expect(existsSync(dirPath)).toBe(true);
    expect(readdirSync(conversationsDir)).toEqual([
      `${new Date(conv.createdAt).toISOString().replace(/:/g, "-")}_${conv.id}`,
    ]);

    const metaPath = join(dirPath, "meta.json");
    expect(existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.id).toBe(conv.id);
    expect(meta.title).toBe("My Conversation");
    expect(meta.type).toBe("standard");
    expect(meta.createdAt).toBe(new Date(conv.createdAt).toISOString());
  });

  test("handles null title in createConversation", () => {
    const conv = createConversation();

    const dirPath = getConversationDirPath(conv.id, conv.createdAt);
    const meta = JSON.parse(readFileSync(join(dirPath, "meta.json"), "utf-8"));
    expect(meta.title).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle integration: addMessage + syncMessageToDisk
// ---------------------------------------------------------------------------

describe("addMessage + syncMessageToDisk → disk view", () => {
  beforeEach(() => {
    resetTables();
    resetConversationsDir();
  });

  test("appends JSONL line for a text message", async () => {
    const conv = createConversation("Msg Test");

    const msg = await addMessage(conv.id, "user", "Hello world", {
      skipIndexing: true,
    });

    syncMessageToDisk(conv.id, msg.id, conv.createdAt);

    const dirPath = getConversationDirPath(conv.id, conv.createdAt);
    const jsonlPath = join(dirPath, "messages.jsonl");
    expect(existsSync(jsonlPath)).toBe(true);

    const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]);
    expect(record.role).toBe("user");
    expect(record.content).toBe("Hello world");
    expect(record.ts).toBeDefined();
  });

  test("message with attachment copies file and includes in JSONL", async () => {
    const conv = createConversation("Attach Test");

    const msg = await addMessage(conv.id, "user", "See attached", {
      skipIndexing: true,
    });

    const att = uploadAttachment("screenshot.png", "image/png", "iVBORw0K");
    linkAttachmentToMessage(msg.id, att.id, 0);

    syncMessageToDisk(conv.id, msg.id, conv.createdAt);

    const dirPath = getConversationDirPath(conv.id, conv.createdAt);

    // Attachment file exists in attachments/ subdirectory
    const attachDir = join(dirPath, "attachments");
    expect(existsSync(join(attachDir, "screenshot.png"))).toBe(true);

    // JSONL references the attachment
    const lines = readFileSync(join(dirPath, "messages.jsonl"), "utf-8")
      .trim()
      .split("\n");
    const record = JSON.parse(lines[0]);
    expect(record.attachments).toEqual(["screenshot.png"]);
  });
});

// ---------------------------------------------------------------------------
// Sync idempotency: one DB row projects to one JSONL record
// ---------------------------------------------------------------------------

describe("syncMessageToDisk idempotency", () => {
  beforeEach(() => {
    resetTables();
    resetConversationsDir();
  });

  function readJsonlLines(convId: string, createdAt: number): string[] {
    const jsonlPath = join(
      getConversationDirPath(convId, createdAt),
      "messages.jsonl",
    );
    return readFileSync(jsonlPath, "utf-8").trim().split("\n");
  }

  test("re-syncing an unchanged row does not append a duplicate record", async () => {
    const conv = createConversation("Idempotent Sync");
    const msg = await addMessage(conv.id, "user", "Hello once", {
      skipIndexing: true,
    });

    syncMessageToDisk(conv.id, msg.id, conv.createdAt);
    syncMessageToDisk(conv.id, msg.id, conv.createdAt);
    syncMessageToDisk(conv.id, msg.id, conv.createdAt);

    const lines = readJsonlLines(conv.id, conv.createdAt);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).content).toBe("Hello once");
  });

  // The grouped tool-result row is written to the DB as each result arrives
  // and projected to JSONL only at finalize. The agent loop used to sync the
  // row once per arriving result AND once at finalize, so a turn with N tool
  // results appended N + 1 byte-identical records; this fixture drives that
  // exact N + 1 call pattern against the same row and asserts the projection
  // holds one record. A retried finalize (e.g. after crash recovery) is the
  // same call shape. The turn-boundary git commit touches no message rows, so
  // a commit timeout with background completion cannot introduce a duplicate
  // either: the only JSONL append for the row is the finalize sync.
  // Parameterized across both persisted tool id shapes: Anthropic-style
  // `toolu_` ids and OpenAI Responses-native `call_` ids.
  for (const idPrefix of ["toolu", "call"] as const) {
    test(`the pre-fix N+1 sync pattern for a grouped tool-result row (${idPrefix}_ ids) projects one record`, async () => {
      const conv = createConversation(`Tool Result Sync ${idPrefix}`);
      const nToolResults = 3;
      const batch = Array.from({ length: nToolResults }, (_, i) => ({
        type: "tool_result",
        tool_use_id: `${idPrefix}_${i + 1}`,
        content: `result ${i + 1}`,
      }));
      const msg = await addMessage(conv.id, "user", JSON.stringify(batch), {
        skipIndexing: true,
      });

      // One sync per arriving tool result, then the finalize sync.
      for (let i = 0; i < nToolResults; i++) {
        syncMessageToDisk(conv.id, msg.id, conv.createdAt);
      }
      syncMessageToDisk(conv.id, msg.id, conv.createdAt);

      const lines = readJsonlLines(conv.id, conv.createdAt);
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]);
      expect(record.role).toBe("user");
      expect(record.toolResults).toEqual(
        batch.map((block) => ({ content: block.content })),
      );
    });
  }

  test("a row whose content changed since its last sync appends a new record", async () => {
    const conv = createConversation("Changed Row");
    const msg = await addMessage(conv.id, "user", "first draft", {
      skipIndexing: true,
    });

    syncMessageToDisk(conv.id, msg.id, conv.createdAt);
    updateMessageContent(msg.id, "final content");
    syncMessageToDisk(conv.id, msg.id, conv.createdAt);

    const lines = readJsonlLines(conv.id, conv.createdAt);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).content).toBe("first draft");
    expect(JSON.parse(lines[1]).content).toBe("final content");
  });

  test("distinct rows each project their own record", async () => {
    const conv = createConversation("Distinct Rows");
    const first = await addMessage(conv.id, "user", "question", {
      skipIndexing: true,
    });
    const second = await addMessage(conv.id, "assistant", "answer", {
      skipIndexing: true,
    });

    syncMessageToDisk(conv.id, first.id, conv.createdAt);
    syncMessageToDisk(conv.id, second.id, conv.createdAt);

    const lines = readJsonlLines(conv.id, conv.createdAt);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).content).toBe("question");
    expect(JSON.parse(lines[1]).content).toBe("answer");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle integration: updateConversationTitle
// ---------------------------------------------------------------------------

describe("updateConversationTitle → disk view", () => {
  beforeEach(() => {
    resetTables();
    resetConversationsDir();
  });

  test("rewrites meta.json with new title", () => {
    const conv = createConversation("Original Title");
    const dirPath = getConversationDirPath(conv.id, conv.createdAt);

    // Verify original
    let meta = JSON.parse(readFileSync(join(dirPath, "meta.json"), "utf-8"));
    expect(meta.title).toBe("Original Title");

    // Update
    updateConversationTitle(conv.id, "New Title");

    // Verify updated
    meta = JSON.parse(readFileSync(join(dirPath, "meta.json"), "utf-8"));
    expect(meta.title).toBe("New Title");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle integration: deleteConversation
// ---------------------------------------------------------------------------

describe("deleteConversation → disk view", () => {
  beforeEach(() => {
    resetTables();
    resetConversationsDir();
  });

  test("removes conversation directory on delete", () => {
    const conv = createConversation("To Delete");
    const dirPath = getConversationDirPath(conv.id, conv.createdAt);
    expect(existsSync(dirPath)).toBe(true);

    deleteConversation(conv.id);

    expect(existsSync(dirPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle integration: clearAll
// ---------------------------------------------------------------------------

describe("clearAll → disk view", () => {
  beforeEach(() => {
    resetTables();
    resetConversationsDir();
  });

  test("empties the conversations directory", async () => {
    // Create two conversations
    createConversation("Conv A");
    createConversation("Conv B");

    // Verify directories exist
    const entries = readdirSync(conversationsDir);
    expect(entries.length).toBe(2);

    // Clear all
    await clearAll();

    // Conversations directory should exist but be empty
    expect(existsSync(conversationsDir)).toBe(true);
    const afterEntries = readdirSync(conversationsDir);
    expect(afterEntries.length).toBe(0);
  });
});
