/**
 * Memory segments are dated by when the content happened, not by when the row
 * was written.
 *
 * `metadata.sentAt` carries the event time whenever persistence lags the
 * event. The segment `created_at` reaches the embedding payload and is what
 * graph search date-range filters on, so a row that reports a stale send time
 * must not be recalled as if it had happened at write time.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

mock.module("../persistence/embeddings/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    hybridSearch: async () => [],
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

import { addMessage } from "../persistence/conversation-crud.js";
import { getDb, getMemoryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  conversations,
  memorySegments,
  messages,
} from "../persistence/schema/index.js";
import { setConfig } from "./helpers/set-config.js";

setConfig("memory", { extraction: { useLLM: false } });

await initializeDb();
getMemoryDb();

const CONVERSATION_ID = "conv-indexed-at-sent-time";

const LONG_TEXT =
  "Alice prefers VS Code over Vim for large projects and ships at the end " +
  "of the day. She keeps the deploy runbook in the team wiki and reviews " +
  "the rollout checklist before every release so nothing is missed.";

function resetTables(): void {
  const db = getDb();
  getMemoryDb()!.run("DELETE FROM memory_segments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");

  const now = Date.now();
  db.insert(conversations)
    .values({
      id: CONVERSATION_ID,
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
}

function segmentTimestampsFor(messageId: string): number[] {
  return getMemoryDb()!
    .select({ createdAt: memorySegments.createdAt })
    .from(memorySegments)
    .where(eq(memorySegments.messageId, messageId))
    .all()
    .map((row) => row.createdAt);
}

function rowCreatedAt(messageId: string): number {
  return getDb()
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()!.createdAt;
}

function blocks(text: string): string {
  return JSON.stringify([{ type: "text", text }]);
}

beforeEach(() => {
  resetTables();
});

describe("memory segment dating", () => {
  test("segments are dated by sentAt when the row reports one", async () => {
    const sentAt = Date.UTC(2026, 6, 8, 9, 15);
    const saved = await addMessage(CONVERSATION_ID, "user", blocks(LONG_TEXT), {
      metadata: { sentAt },
    });

    const timestamps = segmentTimestampsFor(saved.id);
    expect(timestamps.length).toBeGreaterThan(0);
    for (const ts of timestamps) {
      expect(ts).toBe(sentAt);
    }
    // The gap is the point: without it this would pass on a segment that
    // simply echoed the write time.
    expect(rowCreatedAt(saved.id)).toBeGreaterThan(sentAt);
  });

  test("segments fall back to the row's own time when no sentAt is present", async () => {
    const saved = await addMessage(CONVERSATION_ID, "user", blocks(LONG_TEXT));

    const timestamps = segmentTimestampsFor(saved.id);
    expect(timestamps.length).toBeGreaterThan(0);
    for (const ts of timestamps) {
      expect(ts).toBe(rowCreatedAt(saved.id));
    }
  });
});
