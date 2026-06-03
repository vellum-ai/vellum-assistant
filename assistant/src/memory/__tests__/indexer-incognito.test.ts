// Incognito conversations must never produce memories. `indexMessageNow` is
// the single entry to indexing — segment storage/embedding, graph_extract,
// memory_v2_sweep, auto-analysis, conversation-summary, and the retrospective
// enqueue all funnel through it. Callers resolve the conversation's incognito
// flag and pass it via IndexMessageInput; this suite asserts the gate at the
// top of `indexMessageNow` short-circuits every one of those paths when the
// flag is set, and indexes normally when it is not.
//
// Conversation/message rows are seeded directly via the db rather than through
// `createConversation` to keep this file's import graph minimal: the partial
// `mock.module` of config/loader (mirroring memory-upsert-concurrency.test.ts)
// leaks across the suite, and pulling in conversation-crud's heavier import
// chain trips named-import resolution under that leak.

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import { DEFAULT_CONFIG } from "../../config/defaults.js";

const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    enabled: true,
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
    },
  },
};

mock.module("../../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

import { getDb, getSqlite } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import { indexMessageNow } from "../indexer.js";
import { conversations, memorySegments, messages } from "../schema.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM memory_embeddings");
  db.run("DELETE FROM memory_graph_nodes");
  db.run("DELETE FROM memory_segments");
  db.run("DELETE FROM memory_jobs");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

const SAMPLE_TEXT =
  "I prefer TypeScript over plain JavaScript for large projects and I live in Berlin.";

function seedConversationAndMessage(
  conversationId: string,
  messageId: string,
): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id: conversationId,
      title: null,
      createdAt: now,
      updatedAt: now,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      contextSummary: null,
      contextCompactedMessageCount: 0,
      contextCompactedAt: null,
    })
    .run();
  db.insert(messages)
    .values({
      id: messageId,
      conversationId,
      role: "user",
      content: JSON.stringify([{ type: "text", text: SAMPLE_TEXT }]),
      createdAt: now,
    })
    .run();
}

describe("indexMessageNow incognito gate", () => {
  beforeEach(() => {
    resetTables();
  });

  test("stores nothing and enqueues nothing for an incognito conversation", async () => {
    const conversationId = "conv-incognito";
    const messageId = "msg-incognito";
    seedConversationAndMessage(conversationId, messageId);

    const result = await indexMessageNow(
      {
        messageId,
        conversationId,
        role: "user",
        content: JSON.stringify([{ type: "text", text: SAMPLE_TEXT }]),
        createdAt: Date.now(),
        incognito: true,
      },
      TEST_CONFIG.memory,
    );

    expect(result.indexedSegments).toBe(0);
    expect(result.enqueuedJobs).toBe(0);

    const segments = getDb()
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();
    expect(segments).toHaveLength(0);

    // No memory jobs (embed/graph_extract/sweep/auto-analysis/summary) were
    // enqueued either — the gate short-circuits before any enqueue site.
    const jobRow = getSqlite()
      .query("SELECT COUNT(*) AS n FROM memory_jobs")
      .get() as { n: number } | null;
    expect(jobRow?.n).toBe(0);
  });

  test("a normal conversation still indexes segments", async () => {
    const conversationId = "conv-normal";
    const messageId = "msg-normal";
    seedConversationAndMessage(conversationId, messageId);

    const result = await indexMessageNow(
      {
        messageId,
        conversationId,
        role: "user",
        content: JSON.stringify([{ type: "text", text: SAMPLE_TEXT }]),
        createdAt: Date.now(),
        incognito: false,
      },
      TEST_CONFIG.memory,
    );

    expect(result.indexedSegments).toBeGreaterThan(0);

    const segments = getDb()
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();
    expect(segments.length).toBeGreaterThan(0);
  });
});
