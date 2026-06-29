import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../__tests__/helpers/mock-logger.js";

mock.module("../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import {
  addMessage,
  createConversation,
  deleteConversationGently,
  getMessages,
} from "../../persistence/conversation-crud.js";
import { getDb, getSqlite } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import {
  buildForkDeleteBatchScript,
  deleteForkMessagesViaSubprocess,
} from "../../persistence/fork-message-delete.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM memory_segments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function countMessages(conversationId: string): number {
  return getMessages(conversationId).length;
}

describe("deleteForkMessagesViaSubprocess", () => {
  beforeEach(() => {
    resetTables();
  });

  test("deletes every message across batch boundaries", async () => {
    const conv = createConversation("source");
    for (let i = 0; i < 5; i++) {
      await addMessage(conv.id, "user", `m${i}`, { skipIndexing: true });
    }
    expect(countMessages(conv.id)).toBe(5);

    const result = await deleteForkMessagesViaSubprocess({
      conversationId: conv.id,
      batchSize: 2,
      forceInProcess: true,
    });
    expect(result.ok).toBe(true);
    expect(countMessages(conv.id)).toBe(0);
  });

  test("is a no-op on a conversation with no messages", async () => {
    const conv = createConversation("empty");
    const result = await deleteForkMessagesViaSubprocess({
      conversationId: conv.id,
      forceInProcess: true,
    });
    expect(result.ok).toBe(true);
    expect(countMessages(conv.id)).toBe(0);
  });

  test("leaves other conversations' messages untouched", async () => {
    const target = createConversation("target");
    const keep = createConversation("keep");
    await addMessage(target.id, "user", "delete me", { skipIndexing: true });
    await addMessage(keep.id, "user", "keep me", { skipIndexing: true });

    const result = await deleteForkMessagesViaSubprocess({
      conversationId: target.id,
      forceInProcess: true,
    });
    expect(result.ok).toBe(true);
    expect(countMessages(target.id)).toBe(0);
    expect(countMessages(keep.id)).toBe(1);
  });

  test("cascades to memory_segments linked to the deleted messages", async () => {
    const conv = createConversation("with-segments");
    const msg = await addMessage(conv.id, "user", "segment me", {
      skipIndexing: true,
    });
    const db = getDb();
    const now = Date.now();
    db.run(
      `INSERT INTO memory_segments
        (id, message_id, conversation_id, role, segment_index, text, token_estimate, created_at, updated_at)
       VALUES ('seg-1', '${msg.id}', '${conv.id}', 'user', 0, 'segment me', 2, ${now}, ${now})`,
    );
    expect(
      getSqlite().query("SELECT COUNT(*) AS c FROM memory_segments").get(),
    ).toEqual({ c: 1 });

    const result = await deleteForkMessagesViaSubprocess({
      conversationId: conv.id,
      forceInProcess: true,
    });
    expect(result.ok).toBe(true);
    expect(
      getSqlite().query("SELECT COUNT(*) AS c FROM memory_segments").get(),
    ).toEqual({ c: 0 });
  });
});

describe("deleteConversationGently", () => {
  beforeEach(() => {
    resetTables();
  });

  test("removes the conversation and returns its linked segment ids", async () => {
    const conv = createConversation("doomed");
    const msg = await addMessage(conv.id, "user", "bye", {
      skipIndexing: true,
    });
    const db = getDb();
    const now = Date.now();
    db.run(
      `INSERT INTO memory_segments
        (id, message_id, conversation_id, role, segment_index, text, token_estimate, created_at, updated_at)
       VALUES ('seg-gentle', '${msg.id}', '${conv.id}', 'user', 0, 'bye', 1, ${now}, ${now})`,
    );

    const result = await deleteConversationGently(conv.id);
    expect(result.segmentIds).toEqual(["seg-gentle"]);
    expect(countMessages(conv.id)).toBe(0);
    expect(
      getSqlite().query(`SELECT COUNT(*) AS c FROM conversations`).get(),
    ).toEqual({ c: 0 });
    expect(
      getSqlite().query("SELECT COUNT(*) AS c FROM memory_segments").get(),
    ).toEqual({ c: 0 });
  });
});

describe("buildForkDeleteBatchScript", () => {
  test("rejects an unsafe conversation id", () => {
    expect(() =>
      buildForkDeleteBatchScript("abc'); DROP TABLE messages;--", 50),
    ).toThrow(/unsafe id/);
  });

  test("enables foreign keys and bounds the batch", () => {
    const sql = buildForkDeleteBatchScript("conv-123", 50);
    expect(sql).toContain("PRAGMA foreign_keys=ON;");
    expect(sql).toContain("LIMIT 50");
    expect(sql).toContain("SELECT changes();");
  });
});
