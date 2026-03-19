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
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must come before any imports that depend on them
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "conv-disk-view-test-"));
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

import {
  linkAttachmentToMessage,
  uploadAttachment,
} from "../memory/attachments-store.js";
import {
  addMessage,
  createConversation,
  deleteMessageById,
  relinkAttachments,
  updateMessageContent,
} from "../memory/conversation-crud.js";
import {
  flattenContentBlocks,
  getConversationDirName,
  getConversationDirPath,
  initConversationDir,
  rebuildConversationDiskViewFromDbState,
  removeConversationDir,
  resolveUniqueFilename,
  syncMessageToDisk,
  updateMetaFile,
} from "../memory/conversation-disk-view.js";
import { getDb, initializeDb, rawRun, resetDb } from "../memory/db.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
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

function getLegacyConversationDirName(id: string, createdAtMs: number): string {
  return `${id}_${new Date(createdAtMs).toISOString().replace(/:/g, "-")}`;
}

// ---------------------------------------------------------------------------
// getConversationDirName
// ---------------------------------------------------------------------------

describe("getConversationDirName", () => {
  test("produces filesystem-safe name with colons replaced by hyphens", () => {
    // 2026-03-18T14:23:00.000Z
    const ts = new Date("2026-03-18T14:23:00.000Z").getTime();
    const name = getConversationDirName("abc123", ts);
    expect(name).toBe("2026-03-18T14-23-00.000Z_abc123");
    // No colons in the name (safe for Windows/macOS/Linux)
    expect(name).not.toContain(":");
  });

  test("handles epoch zero", () => {
    const name = getConversationDirName("conv0", 0);
    expect(name).toBe("1970-01-01T00-00-00.000Z_conv0");
  });
});

// ---------------------------------------------------------------------------
// getConversationDirPath
// ---------------------------------------------------------------------------

describe("getConversationDirPath", () => {
  test("returns absolute path under conversations dir", () => {
    const ts = Date.now();
    const dirPath = getConversationDirPath("test-id", ts);
    expect(dirPath.startsWith(conversationsDir)).toBe(true);
    expect(dirPath).toContain("_test-id");
  });
});

// ---------------------------------------------------------------------------
// initConversationDir
// ---------------------------------------------------------------------------

describe("initConversationDir", () => {
  beforeEach(resetTables);

  test("creates directory and writes valid meta.json", () => {
    const now = Date.now();
    initConversationDir({
      id: "conv-init-1",
      title: "Test Conversation",
      createdAt: now,
      conversationType: "standard",
      originChannel: "desktop",
    });

    const dirPath = getConversationDirPath("conv-init-1", now);
    expect(existsSync(dirPath)).toBe(true);

    const metaPath = join(dirPath, "meta.json");
    expect(existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.id).toBe("conv-init-1");
    expect(meta.title).toBe("Test Conversation");
    expect(meta.type).toBe("standard");
    expect(meta.channel).toBe("desktop");
    expect(meta.createdAt).toBe(new Date(now).toISOString());
    expect(meta.updatedAt).toBe(new Date(now).toISOString());

    // Cleanup
    rmSync(dirPath, { recursive: true, force: true });
  });

  test("handles null title and null originChannel", () => {
    const now = Date.now();
    initConversationDir({
      id: "conv-init-null",
      title: null,
      createdAt: now,
      conversationType: "private",
      originChannel: null,
    });

    const dirPath = getConversationDirPath("conv-init-null", now);
    const meta = JSON.parse(readFileSync(join(dirPath, "meta.json"), "utf-8"));
    expect(meta.title).toBeNull();
    expect(meta.channel).toBeNull();
    expect(meta.type).toBe("private");

    rmSync(dirPath, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// updateMetaFile
// ---------------------------------------------------------------------------

describe("updateMetaFile", () => {
  beforeEach(resetTables);

  test("rewrites meta.json with updated fields", () => {
    const created = Date.now();
    const updated = created + 5000;

    initConversationDir({
      id: "conv-update",
      title: "Original",
      createdAt: created,
      conversationType: "standard",
      originChannel: null,
    });

    updateMetaFile({
      id: "conv-update",
      title: "Updated Title",
      createdAt: created,
      updatedAt: updated,
      conversationType: "standard",
      originChannel: "telegram",
    });

    const dirPath = getConversationDirPath("conv-update", created);
    const meta = JSON.parse(readFileSync(join(dirPath, "meta.json"), "utf-8"));
    expect(meta.title).toBe("Updated Title");
    expect(meta.channel).toBe("telegram");
    expect(meta.updatedAt).toBe(new Date(updated).toISOString());

    rmSync(dirPath, { recursive: true, force: true });
  });

  test("reuses legacy directory names when the new directory does not exist", () => {
    const created = Date.now();
    const legacyDirName = getLegacyConversationDirName("conv-legacy", created);
    const legacyDirPath = join(conversationsDir, legacyDirName);
    mkdirSync(legacyDirPath, { recursive: true });

    updateMetaFile({
      id: "conv-legacy",
      title: "Legacy",
      createdAt: created,
      updatedAt: created + 1234,
      conversationType: "standard",
      originChannel: "desktop",
    });

    expect(existsSync(join(legacyDirPath, "meta.json"))).toBe(true);
    expect(existsSync(getConversationDirPath("conv-legacy", created))).toBe(
      false,
    );

    rmSync(legacyDirPath, { recursive: true, force: true });
  });

  test("recreates a missing directory before rewriting meta.json", () => {
    const created = Date.now();
    const updated = created + 2500;
    initConversationDir({
      id: "conv-update-recreate",
      title: "Original",
      createdAt: created,
      conversationType: "standard",
      originChannel: null,
    });

    const dirPath = getConversationDirPath("conv-update-recreate", created);
    rmSync(dirPath, { recursive: true, force: true });

    updateMetaFile({
      id: "conv-update-recreate",
      title: "Recreated",
      createdAt: created,
      updatedAt: updated,
      conversationType: "standard",
      originChannel: "desktop",
    });

    expect(existsSync(dirPath)).toBe(true);
    expect(existsSync(join(dirPath, "meta.json"))).toBe(true);

    const meta = JSON.parse(readFileSync(join(dirPath, "meta.json"), "utf-8"));
    expect(meta.title).toBe("Recreated");
    expect(meta.channel).toBe("desktop");
    expect(meta.updatedAt).toBe(new Date(updated).toISOString());

    rmSync(dirPath, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// flattenContentBlocks
// ---------------------------------------------------------------------------

describe("flattenContentBlocks", () => {
  test("extracts text from text blocks", () => {
    const blocks = JSON.stringify([
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ]);
    const result = flattenContentBlocks(blocks);
    expect(result.content).toBe("Hello\nWorld");
    expect(result.toolCalls).toEqual([]);
    expect(result.toolResults).toEqual([]);
  });

  test("extracts tool_use blocks", () => {
    const blocks = JSON.stringify([
      { type: "tool_use", name: "image_resize", input: { width: 800 } },
    ]);
    const result = flattenContentBlocks(blocks);
    expect(result.toolCalls).toEqual([
      { name: "image_resize", input: { width: 800 } },
    ]);
  });

  test("extracts tool_result blocks", () => {
    const blocks = JSON.stringify([{ type: "tool_result", content: "Done!" }]);
    const result = flattenContentBlocks(blocks);
    expect(result.toolResults).toEqual([{ content: "Done!" }]);
  });

  test("skips image and file blocks", () => {
    const blocks = JSON.stringify([
      { type: "text", text: "Here is an image" },
      { type: "image", source: { data: "base64..." } },
      { type: "file", path: "/tmp/test.txt" },
    ]);
    const result = flattenContentBlocks(blocks);
    expect(result.content).toBe("Here is an image");
    expect(result.toolCalls).toEqual([]);
    expect(result.toolResults).toEqual([]);
  });

  test("handles plain text (non-JSON) content", () => {
    const result = flattenContentBlocks("Just a string message");
    expect(result.content).toBe("Just a string message");
  });

  test("handles non-array JSON gracefully", () => {
    const result = flattenContentBlocks(
      JSON.stringify({ text: "not an array" }),
    );
    expect(result.content).toBe(JSON.stringify({ text: "not an array" }));
  });

  test("handles mixed block types", () => {
    const blocks = JSON.stringify([
      { type: "text", text: "Can you resize this?" },
      { type: "image", source: { data: "abc" } },
      { type: "tool_use", name: "image_resize", input: { width: 800 } },
      { type: "tool_result", content: "Resized to 800x600" },
      { type: "text", text: "Done." },
    ]);
    const result = flattenContentBlocks(blocks);
    expect(result.content).toBe("Can you resize this?\nDone.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolResults).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// resolveUniqueFilename
// ---------------------------------------------------------------------------

describe("resolveUniqueFilename", () => {
  test("returns original filename when no collision", () => {
    const dir = mkdtempSync(join(tmpdir(), "unique-fn-"));
    expect(resolveUniqueFilename(dir, "photo.png")).toBe("photo.png");
    rmSync(dir, { recursive: true });
  });

  test("appends -2, -3 on collision", () => {
    const dir = mkdtempSync(join(tmpdir(), "unique-fn-"));
    writeFileSync(join(dir, "photo.png"), "");
    expect(resolveUniqueFilename(dir, "photo.png")).toBe("photo-2.png");

    writeFileSync(join(dir, "photo-2.png"), "");
    expect(resolveUniqueFilename(dir, "photo.png")).toBe("photo-3.png");

    rmSync(dir, { recursive: true });
  });

  test("handles files without extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "unique-fn-"));
    writeFileSync(join(dir, "README"), "");
    expect(resolveUniqueFilename(dir, "README")).toBe("README-2");
    rmSync(dir, { recursive: true });
  });

  test("strips path traversal sequences from filename", () => {
    const dir = mkdtempSync(join(tmpdir(), "unique-fn-"));
    expect(resolveUniqueFilename(dir, "../../evil.txt")).toBe("evil.txt");
    expect(resolveUniqueFilename(dir, "../secret.png")).toBe("secret.png");
    expect(resolveUniqueFilename(dir, "foo/bar/baz.txt")).toBe("baz.txt");
    rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// syncMessageToDisk
// ---------------------------------------------------------------------------

describe("syncMessageToDisk", () => {
  beforeEach(resetTables);

  test("appends correct JSONL for text-only message", async () => {
    const conv = createConversation("Test");
    initConversationDir({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      conversationType: conv.conversationType,
      originChannel: null,
    });

    const msg = await addMessage(
      conv.id,
      "user",
      "Hello, assistant!",
      undefined,
      { skipIndexing: true },
    );

    syncMessageToDisk(conv.id, msg.id, conv.createdAt);

    const dirPath = getConversationDirPath(conv.id, conv.createdAt);
    const jsonlPath = join(dirPath, "messages.jsonl");
    expect(existsSync(jsonlPath)).toBe(true);

    const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]);
    expect(record.role).toBe("user");
    expect(record.content).toBe("Hello, assistant!");
    expect(record.ts).toBeDefined();
    expect(record.toolCalls).toBeUndefined();
    expect(record.attachments).toBeUndefined();

    rmSync(dirPath, { recursive: true, force: true });
  });

  test("appends correct JSONL for message with tool calls", async () => {
    const conv = createConversation("Tool Test");
    initConversationDir({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      conversationType: conv.conversationType,
      originChannel: null,
    });

    const content = JSON.stringify([
      { type: "text", text: "Resizing image..." },
      { type: "tool_use", name: "image_resize", input: { width: 800 } },
    ]);

    const msg = await addMessage(conv.id, "assistant", content, undefined, {
      skipIndexing: true,
    });

    syncMessageToDisk(conv.id, msg.id, conv.createdAt);

    const dirPath = getConversationDirPath(conv.id, conv.createdAt);
    const lines = readFileSync(join(dirPath, "messages.jsonl"), "utf-8")
      .trim()
      .split("\n");
    const record = JSON.parse(lines[0]);
    expect(record.content).toBe("Resizing image...");
    expect(record.toolCalls).toEqual([
      { name: "image_resize", input: { width: 800 } },
    ]);

    rmSync(dirPath, { recursive: true, force: true });
  });

  test("copies attachments and includes filenames in JSONL", async () => {
    const conv = createConversation("Attach Test");
    initConversationDir({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      conversationType: conv.conversationType,
      originChannel: null,
    });

    const msg = await addMessage(conv.id, "user", "See attached", undefined, {
      skipIndexing: true,
    });

    // Upload an attachment and link to the message
    const att = uploadAttachment("photo.png", "image/png", "iVBORw0K");
    linkAttachmentToMessage(msg.id, att.id, 0);

    syncMessageToDisk(conv.id, msg.id, conv.createdAt);

    const dirPath = getConversationDirPath(conv.id, conv.createdAt);
    const attachDir = join(dirPath, "attachments");
    expect(existsSync(join(attachDir, "photo.png"))).toBe(true);

    const lines = readFileSync(join(dirPath, "messages.jsonl"), "utf-8")
      .trim()
      .split("\n");
    const record = JSON.parse(lines[0]);
    expect(record.attachments).toEqual(["photo.png"]);

    rmSync(dirPath, { recursive: true, force: true });
  });

  test("appends multiple messages sequentially", async () => {
    const conv = createConversation("Multi");
    initConversationDir({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      conversationType: conv.conversationType,
      originChannel: null,
    });

    const msg1 = await addMessage(conv.id, "user", "First", undefined, {
      skipIndexing: true,
    });
    const msg2 = await addMessage(conv.id, "assistant", "Second", undefined, {
      skipIndexing: true,
    });

    syncMessageToDisk(conv.id, msg1.id, conv.createdAt);
    syncMessageToDisk(conv.id, msg2.id, conv.createdAt);

    const dirPath = getConversationDirPath(conv.id, conv.createdAt);
    const lines = readFileSync(join(dirPath, "messages.jsonl"), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).role).toBe("user");
    expect(JSON.parse(lines[1]).role).toBe("assistant");

    rmSync(dirPath, { recursive: true, force: true });
  });

  test("appends to a legacy directory when that is the only existing path", async () => {
    const conv = createConversation("Legacy Attach Test");
    const createdAt = conv.createdAt;
    const newDirPath = getConversationDirPath(conv.id, createdAt);
    rmSync(newDirPath, { recursive: true, force: true });
    const legacyDirPath = join(
      conversationsDir,
      getLegacyConversationDirName(conv.id, createdAt),
    );
    mkdirSync(legacyDirPath, { recursive: true });

    const msg = await addMessage(conv.id, "user", "Legacy path", undefined, {
      skipIndexing: true,
    });

    const att = uploadAttachment("legacy.png", "image/png", "iVBORw0K");
    linkAttachmentToMessage(msg.id, att.id, 0);

    syncMessageToDisk(conv.id, msg.id, createdAt);

    expect(
      existsSync(join(legacyDirPath, "messages.jsonl")),
    ).toBe(true);
    expect(existsSync(join(newDirPath, "messages.jsonl"))).toBe(false);
    expect(existsSync(join(legacyDirPath, "attachments", "legacy.png"))).toBe(
      true,
    );

    rmSync(legacyDirPath, { recursive: true, force: true });
  });

  test("recreates a missing directory before appending messages and attachments", async () => {
    const conv = createConversation("Recreate Sync");
    initConversationDir({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      conversationType: conv.conversationType,
      originChannel: null,
    });

    const msg = await addMessage(conv.id, "user", "Disk repair", undefined, {
      skipIndexing: true,
    });
    const att = uploadAttachment("repair.png", "image/png", "iVBORw0K");
    rawRun(
      `INSERT INTO message_attachments (id, message_id, attachment_id, position, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      `manual-link-${msg.id}`,
      msg.id,
      att.id,
      0,
      Date.now(),
    );

    const dirPath = getConversationDirPath(conv.id, conv.createdAt);
    const legacyDirPath = join(
      conversationsDir,
      getLegacyConversationDirName(conv.id, conv.createdAt),
    );
    rmSync(dirPath, { recursive: true, force: true });
    rmSync(legacyDirPath, { recursive: true, force: true });

    syncMessageToDisk(conv.id, msg.id, conv.createdAt);

    expect(existsSync(dirPath)).toBe(true);
    expect(existsSync(join(dirPath, "messages.jsonl"))).toBe(true);
    expect(existsSync(join(dirPath, "attachments", "repair.png"))).toBe(true);

    const lines = readFileSync(join(dirPath, "messages.jsonl"), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.content).toBe("Disk repair");
    expect(record.attachments).toHaveLength(1);
    expect(existsSync(join(dirPath, "attachments", record.attachments[0]))).toBe(
      true,
    );

    rmSync(dirPath, { recursive: true, force: true });
  });
});

describe("rebuildConversationDiskViewFromDbState", () => {
  beforeEach(resetTables);

  test("rewrites stale pre-consolidation disk view with final DB state", async () => {
    const conv = createConversation("Consolidation Repair");
    initConversationDir({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      conversationType: conv.conversationType,
      originChannel: null,
    });

    const userMsg = await addMessage(conv.id, "user", "find docs", undefined, {
      skipIndexing: true,
    });
    const assistantPart1 = await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "Searching..." }]),
      undefined,
      { skipIndexing: true },
    );
    const internalToolResult = await addMessage(
      conv.id,
      "user",
      JSON.stringify([
        { type: "tool_result", tool_use_id: "tool-1", content: "done" },
      ]),
      undefined,
      { skipIndexing: true },
    );
    const assistantPart2 = await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "Found it." }]),
      undefined,
      { skipIndexing: true },
    );

    const att = uploadAttachment("result.txt", "text/plain", "ok");
    linkAttachmentToMessage(assistantPart2.id, att.id, 0);

    // Simulate stale disk view generated before consolidation.
    syncMessageToDisk(conv.id, userMsg.id, conv.createdAt);
    syncMessageToDisk(conv.id, assistantPart1.id, conv.createdAt);
    syncMessageToDisk(conv.id, internalToolResult.id, conv.createdAt);
    syncMessageToDisk(conv.id, assistantPart2.id, conv.createdAt);

    // Simulate DB mutations performed by consolidation.
    updateMessageContent(
      assistantPart1.id,
      JSON.stringify([
        { type: "text", text: "Searching..." },
        { type: "tool_result", tool_use_id: "tool-1", content: "done" },
        { type: "text", text: "Found it." },
      ]),
    );
    relinkAttachments([assistantPart2.id], assistantPart1.id);
    deleteMessageById(internalToolResult.id);
    deleteMessageById(assistantPart2.id);

    rebuildConversationDiskViewFromDbState(conv.id);

    const dirPath = getConversationDirPath(conv.id, conv.createdAt);
    const lines = readFileSync(join(dirPath, "messages.jsonl"), "utf-8")
      .trim()
      .split("\n");

    expect(lines).toHaveLength(2);

    const rebuiltUser = JSON.parse(lines[0]);
    const rebuiltAssistant = JSON.parse(lines[1]);

    expect(rebuiltUser.role).toBe("user");
    expect(rebuiltAssistant.role).toBe("assistant");
    expect(rebuiltAssistant.content).toBe("Searching...\nFound it.");
    expect(rebuiltAssistant.toolResults).toEqual([{ content: "done" }]);
    expect(rebuiltAssistant.attachments).toHaveLength(1);
    expect(
      existsSync(join(dirPath, "attachments", rebuiltAssistant.attachments[0])),
    ).toBe(true);

    rmSync(dirPath, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// removeConversationDir
// ---------------------------------------------------------------------------

describe("removeConversationDir", () => {
  test("removes the directory and its contents", () => {
    const now = Date.now();
    initConversationDir({
      id: "conv-remove",
      title: "To be removed",
      createdAt: now,
      conversationType: "standard",
      originChannel: null,
    });

    const dirPath = getConversationDirPath("conv-remove", now);
    expect(existsSync(dirPath)).toBe(true);

    removeConversationDir("conv-remove", now);
    expect(existsSync(dirPath)).toBe(false);
  });

  test("handles non-existent directory gracefully", () => {
    // Should not throw
    removeConversationDir("nonexistent", Date.now());
  });

  test("removes both new-format and legacy directories when both exist", () => {
    const created = Date.now();
    const newDirPath = getConversationDirPath("conv-both", created);
    const legacyDirPath = join(
      conversationsDir,
      getLegacyConversationDirName("conv-both", created),
    );
    mkdirSync(newDirPath, { recursive: true });
    mkdirSync(legacyDirPath, { recursive: true });

    removeConversationDir("conv-both", created);

    expect(existsSync(newDirPath)).toBe(false);
    expect(existsSync(legacyDirPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe("error resilience", () => {
  test("initConversationDir does not throw on write failure", () => {
    // Create a file at the path where a directory would be created, so
    // mkdirSync fails with EEXIST. This triggers the try/catch in
    // initConversationDir. The function should swallow the error.
    const badConvId = "conv-fail-write";
    const now = Date.now();
    const dirPath = getConversationDirPath(badConvId, now);

    mkdirSync(conversationsDir, { recursive: true });
    writeFileSync(dirPath, "blocker");

    try {
      // Should not throw despite the internal failure
      expect(() => {
        initConversationDir({
          id: badConvId,
          title: "Test",
          createdAt: now,
          conversationType: "standard",
          originChannel: null,
        });
      }).not.toThrow();
    } finally {
      rmSync(dirPath, { force: true });
    }
  });

  test("updateMetaFile does not throw when directory does not exist", () => {
    expect(() => {
      updateMetaFile({
        id: "nonexistent",
        title: "X",
        createdAt: 1000,
        updatedAt: 2000,
        conversationType: "standard",
        originChannel: null,
      });
    }).not.toThrow();
  });

  test("syncMessageToDisk does not throw when message is not found", () => {
    // Should not throw — logs a warning instead
    expect(() => {
      syncMessageToDisk("missing-conv", "missing-msg", Date.now());
    }).not.toThrow();
  });

  test("removeConversationDir does not throw on missing directory", () => {
    expect(() => {
      removeConversationDir("nonexistent-id", 0);
    }).not.toThrow();
  });
});
