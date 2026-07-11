import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "../../../../__tests__/helpers/set-config.js";

// Disable memory so `addMessage` does not index into the real memory
// pipeline (both flags default true under the real loader).
setConfig("memory", { enabled: false, v2: { enabled: false } });

import {
  addMessage,
  createConversation,
  deleteConversationGently,
  getMessages,
} from "../../../../persistence/conversation-crud.js";
import {
  buildBatchDeleteScript,
  deleteConversationRowsInBatches,
} from "../../../../persistence/conversation-row-batch-delete.js";
import { getDb, getSqlite } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";

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

describe("deleteConversationRowsInBatches", () => {
  beforeEach(() => {
    resetTables();
  });

  test("deletes every message across batch boundaries", async () => {
    const conv = createConversation("source");
    for (let i = 0; i < 5; i++) {
      await addMessage(conv.id, "user", `m${i}`, { skipIndexing: true });
    }
    expect(countMessages(conv.id)).toBe(5);

    const result = await deleteConversationRowsInBatches({
      conversationId: conv.id,
      table: "messages",
      enableForeignKeys: true,
      batchSize: 2,
      forceInProcess: true,
    });
    expect(result.ok).toBe(true);
    expect(countMessages(conv.id)).toBe(0);
  });

  test("is a no-op on a conversation with no rows", async () => {
    const conv = createConversation("empty");
    const result = await deleteConversationRowsInBatches({
      conversationId: conv.id,
      table: "messages",
      enableForeignKeys: true,
      forceInProcess: true,
    });
    expect(result.ok).toBe(true);
    expect(countMessages(conv.id)).toBe(0);
  });

  test("leaves other conversations' rows untouched", async () => {
    const target = createConversation("target");
    const keep = createConversation("keep");
    await addMessage(target.id, "user", "delete me", { skipIndexing: true });
    await addMessage(keep.id, "user", "keep me", { skipIndexing: true });

    const result = await deleteConversationRowsInBatches({
      conversationId: target.id,
      table: "messages",
      enableForeignKeys: true,
      forceInProcess: true,
    });
    expect(result.ok).toBe(true);
    expect(countMessages(target.id)).toBe(0);
    expect(countMessages(keep.id)).toBe(1);
  });

  test("cascades to memory_segments when foreign keys are enabled", async () => {
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

    const result = await deleteConversationRowsInBatches({
      conversationId: conv.id,
      table: "messages",
      enableForeignKeys: true,
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

describe("buildBatchDeleteScript", () => {
  test("rejects an unsafe conversation id", () => {
    expect(() =>
      buildBatchDeleteScript({
        conversationId: "abc'); DROP TABLE messages;--",
        table: "messages",
        batchSize: 50,
      }),
    ).toThrow(/unsafe id/);
  });

  test("rejects an unsafe table identifier", () => {
    expect(() =>
      buildBatchDeleteScript({
        conversationId: "conv-123",
        table: "messages; DROP TABLE conversations;--",
        batchSize: 50,
      }),
    ).toThrow(/unsafe table/);
  });

  test("enables foreign keys only when requested and bounds the batch", () => {
    const withFk = buildBatchDeleteScript({
      conversationId: "conv-123",
      table: "messages",
      enableForeignKeys: true,
      batchSize: 50,
    });
    expect(withFk).toContain("PRAGMA foreign_keys=ON;");
    expect(withFk).toContain("DELETE FROM messages");
    expect(withFk).toContain("LIMIT 50");
    expect(withFk).toContain("SELECT changes();");

    const withoutFk = buildBatchDeleteScript({
      conversationId: "conv-123",
      table: "llm_request_logs",
      batchSize: 25,
    });
    expect(withoutFk).not.toContain("PRAGMA foreign_keys=ON;");
    expect(withoutFk).toContain("DELETE FROM llm_request_logs");
    expect(withoutFk).toContain("LIMIT 25");
  });
});
