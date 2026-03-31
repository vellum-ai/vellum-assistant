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
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must come before any imports that depend on them
// ---------------------------------------------------------------------------

const workspaceDir = process.env.VELLUM_WORKSPACE_DIR!;
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

import {
  linkAttachmentToMessage,
  uploadAttachment,
} from "../memory/attachments-store.js";
import {
  addMessage,
  clearAll,
  createConversation,
  deleteConversation,
  updateConversationTitle,
} from "../memory/conversation-crud.js";
import {
  getConversationDirPath,
  syncMessageToDisk,
} from "../memory/conversation-disk-view.js";
import { getDb, initializeDb } from "../memory/db.js";

initializeDb();

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

    const msg = await addMessage(conv.id, "user", "Hello world", undefined, {
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

    const msg = await addMessage(conv.id, "user", "See attached", undefined, {
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

  test("empties the conversations directory", () => {
    // Create two conversations
    createConversation("Conv A");
    createConversation("Conv B");

    // Verify directories exist
    const entries = readdirSync(conversationsDir);
    expect(entries.length).toBe(2);

    // Clear all
    clearAll();

    // Conversations directory should exist but be empty
    expect(existsSync(conversationsDir)).toBe(true);
    const afterEntries = readdirSync(conversationsDir);
    expect(afterEntries.length).toBe(0);
  });
});
