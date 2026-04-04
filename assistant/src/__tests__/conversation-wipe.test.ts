import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  addMessage,
  createConversation,
  deleteConversation,
  getConversation,
  getMessages,
  wipeConversation,
} from "../memory/conversation-crud.js";
import { getDb, initializeDb } from "../memory/db.js";
import { enqueueMemoryJob } from "../memory/jobs-store.js";

// Initialize db once before all tests
initializeDb();

describe("wipeConversation", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM memory_graph_nodes`);
    db.run(`DELETE FROM memory_segments`);
    db.run(`DELETE FROM memory_summaries`);
    db.run(`DELETE FROM memory_embeddings`);
    db.run(`DELETE FROM memory_jobs`);
    db.run(`DELETE FROM tool_invocations`);
    db.run(`DELETE FROM llm_request_logs`);
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("wipes conversation and all messages", async () => {
    const conv = createConversation("test");
    await addMessage(conv.id, "user", "first message");
    await addMessage(conv.id, "assistant", "second message");
    await addMessage(conv.id, "user", "third message");

    wipeConversation(conv.id);

    expect(getConversation(conv.id)).toBeNull();
    expect(getMessages(conv.id)).toEqual([]);
  });

  test("deletes conversation summaries", async () => {
    const conv = createConversation("test");
    await addMessage(conv.id, "user", "hello");

    const now = Date.now();

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;

    // Insert a conversation-scoped summary
    raw
      .query(
        `INSERT INTO memory_summaries (id, scope, scope_key, summary, token_estimate, version, scope_id, start_at, end_at, created_at, updated_at)
         VALUES ('sum-1', 'conversation', ?, 'test summary', 100, 1, 'default', ?, ?, ?, ?)`,
      )
      .run(conv.id, now, now, now, now);

    // Insert a corresponding embedding
    raw
      .query(
        `INSERT INTO memory_embeddings (id, target_type, target_id, provider, model, dimensions, created_at, updated_at)
         VALUES ('emb-sum-1', 'summary', 'sum-1', 'test', 'test', 384, ?, ?)`,
      )
      .run(now, now);

    const result = wipeConversation(conv.id);

    // Summary should be deleted
    const summaryRow = raw
      .query("SELECT * FROM memory_summaries WHERE id = 'sum-1'")
      .get();
    expect(summaryRow).toBeNull();

    // Embedding should be deleted
    const embeddingRow = raw
      .query("SELECT * FROM memory_embeddings WHERE id = 'emb-sum-1'")
      .get();
    expect(embeddingRow).toBeNull();

    expect(result.deletedSummaryIds).toContain("sum-1");
  });

  test("cancels pending memory jobs", async () => {
    const conv = createConversation("test");
    await addMessage(conv.id, "user", "hello", undefined, {
      skipIndexing: true,
    });

    // Clear any jobs that might have been created by prior operations
    const db = getDb();
    db.run(`DELETE FROM memory_jobs`);

    enqueueMemoryJob("graph_extract", { conversationId: conv.id });
    enqueueMemoryJob("build_conversation_summary", {
      conversationId: conv.id,
    });

    const result = wipeConversation(conv.id);

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;

    // Both jobs should be failed with conversation_wiped error
    const jobs = raw
      .query("SELECT status, last_error FROM memory_jobs")
      .all() as Array<{ status: string; last_error: string | null }>;

    for (const job of jobs) {
      expect(job.status).toBe("failed");
      expect(job.last_error).toContain("conversation_wiped");
    }

    expect(result.cancelledJobCount).toBeGreaterThanOrEqual(2);
  });

  test("wipe of empty conversation succeeds", () => {
    const conv = createConversation("empty");

    const result = wipeConversation(conv.id);

    expect(getConversation(conv.id)).toBeNull();
    expect(result.segmentIds).toEqual([]);
    expect(result.deletedSummaryIds).toEqual([]);
    expect(result.cancelledJobCount).toBe(0);
  });
});

describe("deleteConversation — private scope cleanup", () => {
  beforeEach(() => {
    const db = getDb();
    db.run(`DELETE FROM conversation_starters`);
    db.run(`DELETE FROM memory_graph_nodes`);
    db.run(`DELETE FROM memory_segments`);
    db.run(`DELETE FROM memory_summaries`);
    db.run(`DELETE FROM memory_embeddings`);
    db.run(`DELETE FROM memory_jobs`);
    db.run(`DELETE FROM tool_invocations`);
    db.run(`DELETE FROM llm_request_logs`);
    db.run(`DELETE FROM messages`);
    db.run(`DELETE FROM conversations`);
  });

  test("summaries cleaned up", () => {
    const conv = createConversation({ conversationType: "private" });
    const scopeId = conv.memoryScopeId;
    const now = Date.now();

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;

    // Insert a memory summary with matching scopeId
    raw
      .query(
        `INSERT INTO memory_summaries (id, scope, scope_key, summary, token_estimate, version, scope_id, start_at, end_at, created_at, updated_at)
         VALUES ('priv-sum-1', 'global', 'all', 'private summary', 100, 1, ?, ?, ?, ?, ?)`,
      )
      .run(scopeId, now, now, now, now);

    const result = deleteConversation(conv.id);

    // Summary should be gone
    const summaryRow = raw
      .query("SELECT * FROM memory_summaries WHERE id = 'priv-sum-1'")
      .get();
    expect(summaryRow).toBeNull();

    // Its ID should be in deletedSummaryIds
    expect(result.deletedSummaryIds).toContain("priv-sum-1");
  });

  test("standard conversations unaffected", async () => {
    // Create a standard conversation and a private one
    const standardConv = createConversation("standard test");
    const privateConv = createConversation({ conversationType: "private" });

    // Delete the private conversation
    deleteConversation(privateConv.id);

    // Standard conversation should still exist
    expect(getConversation(standardConv.id)).not.toBeNull();
  });

  test("conversationStarters cleaned up", () => {
    const conv = createConversation({ conversationType: "private" });
    const scopeId = conv.memoryScopeId;
    const now = Date.now();

    const raw = (
      getDb() as unknown as {
        $client: import("bun:sqlite").Database;
      }
    ).$client;

    // Insert a conversation_starters row with the private scopeId
    raw
      .query(
        `INSERT INTO conversation_starters (id, label, prompt, generation_batch, scope_id, card_type, created_at)
         VALUES ('starter-1', 'Test starter', 'Tell me about tests', 1, ?, 'chip', ?)`,
      )
      .run(scopeId, now);

    // Also insert a default-scope starter that should NOT be deleted
    raw
      .query(
        `INSERT INTO conversation_starters (id, label, prompt, generation_batch, scope_id, card_type, created_at)
         VALUES ('starter-default', 'Default starter', 'Hello', 1, 'default', 'chip', ?)`,
      )
      .run(now);

    deleteConversation(conv.id);

    // Private-scope starter should be gone
    const starterRow = raw
      .query("SELECT * FROM conversation_starters WHERE id = 'starter-1'")
      .get();
    expect(starterRow).toBeNull();

    // Default-scope starter should still exist
    const defaultStarterRow = raw
      .query("SELECT * FROM conversation_starters WHERE id = 'starter-default'")
      .get();
    expect(defaultStarterRow).not.toBeNull();
  });
});
