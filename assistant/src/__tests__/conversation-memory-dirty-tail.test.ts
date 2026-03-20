import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "conv-dirty-tail-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  addMessage,
  createConversation,
  getConversation,
  getMessages,
  markConversationMemoryDirty,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

describe("markConversationMemoryDirty", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("first message marks the conversation dirty with its message ID", async () => {
    const conv = createConversation("test");
    const msg = await addMessage(conv.id, "user", "hello world", undefined, {
      skipIndexing: true,
    });

    const updated = getConversation(conv.id);
    expect(updated).not.toBeNull();
    expect(updated!.memoryDirtyTailSinceMessageId).toBe(msg.id);
  });

  test("repeated messages preserve the original dirty boundary", async () => {
    const conv = createConversation("test");
    const msg1 = await addMessage(conv.id, "user", "first message", undefined, {
      skipIndexing: true,
    });
    const msg2 = await addMessage(
      conv.id,
      "assistant",
      "second message",
      undefined,
      { skipIndexing: true },
    );

    const updated = getConversation(conv.id);
    expect(updated).not.toBeNull();
    // The dirty tail should still point to msg1, not msg2.
    expect(updated!.memoryDirtyTailSinceMessageId).toBe(msg1.id);
    // msg2 should still be persisted normally.
    expect(msg2.id).not.toBe(msg1.id);
  });

  test("markConversationMemoryDirty is a no-op when already dirty", () => {
    const conv = createConversation("test");
    const firstMessageId = "first-msg-id";
    const secondMessageId = "second-msg-id";

    markConversationMemoryDirty(conv.id, firstMessageId);
    const after1 = getConversation(conv.id);
    expect(after1!.memoryDirtyTailSinceMessageId).toBe(firstMessageId);

    markConversationMemoryDirty(conv.id, secondMessageId);
    const after2 = getConversation(conv.id);
    // Still points to the first message — boundary preserved.
    expect(after2!.memoryDirtyTailSinceMessageId).toBe(firstMessageId);
  });

  test("message ordering and persistence semantics are unchanged", async () => {
    const conv = createConversation("test");
    const msg1 = await addMessage(conv.id, "user", "question", undefined, {
      skipIndexing: true,
    });
    const msg2 = await addMessage(conv.id, "assistant", "answer", undefined, {
      skipIndexing: true,
    });
    const msg3 = await addMessage(conv.id, "user", "follow-up", undefined, {
      skipIndexing: true,
    });

    const allMessages = getMessages(conv.id);
    expect(allMessages).toHaveLength(3);
    // Messages are ordered by createdAt ascending.
    expect(allMessages[0].id).toBe(msg1.id);
    expect(allMessages[1].id).toBe(msg2.id);
    expect(allMessages[2].id).toBe(msg3.id);
    expect(allMessages[0].content).toBe("question");
    expect(allMessages[1].content).toBe("answer");
    expect(allMessages[2].content).toBe("follow-up");
    // createdAt is monotonically increasing.
    expect(allMessages[1].createdAt).toBeGreaterThan(allMessages[0].createdAt);
    expect(allMessages[2].createdAt).toBeGreaterThan(allMessages[1].createdAt);
  });

  test("every persisted message marks the conversation dirty", async () => {
    const conv = createConversation("test");

    // Before any messages, the conversation is not dirty.
    const before = getConversation(conv.id);
    expect(before!.memoryDirtyTailSinceMessageId).toBeNull();

    // After the first message, it becomes dirty.
    const msg1 = await addMessage(conv.id, "user", "msg1", undefined, {
      skipIndexing: true,
    });
    const after1 = getConversation(conv.id);
    expect(after1!.memoryDirtyTailSinceMessageId).toBe(msg1.id);

    // After subsequent messages, the dirty boundary stays on msg1.
    await addMessage(conv.id, "assistant", "msg2", undefined, {
      skipIndexing: true,
    });
    await addMessage(conv.id, "user", "msg3", undefined, {
      skipIndexing: true,
    });
    const afterAll = getConversation(conv.id);
    expect(afterAll!.memoryDirtyTailSinceMessageId).toBe(msg1.id);
  });
});
