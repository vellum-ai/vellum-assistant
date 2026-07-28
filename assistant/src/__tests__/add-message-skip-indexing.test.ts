/**
 * Indexing side effects of `addMessage({ skipIndexing })`.
 *
 * A message saved with `skipIndexing: true` must persist (visible in the
 * transcript) while producing NO indexing artifacts: no `memory_segments`
 * rows, no `embed_segment` tickets, no `index_message_lexical` ticket. A
 * message saved without the flag must produce all of them — the default is
 * unchanged. This is the contract the consolidation kickoff prompt relies on
 * (threaded via `runBackgroundJob({ skipPromptIndexing })` →
 * `processMessage({ skipUserMessageIndexing })`).
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
  memoryJobs,
  memorySegments,
  messages,
} from "../persistence/schema/index.js";
import { setConfig } from "./helpers/set-config.js";

// Deterministic extraction: keep the LLM out of the indexer path. Everything
// else (including `memory.enabled: true`) is the schema default.
setConfig("memory", { extraction: { useLLM: false } });

await initializeDb();

// Open the memory connection before any test mutates state so the jobs table
// is reachable through the same path the enqueue helpers use.
getMemoryDb();

const CONVERSATION_ID = "conv-skip-indexing";

const LONG_TEXT =
  "You are running memory consolidation. Read the buffer, route each entry " +
  "into the matching concept page, rewrite the recent file, and trim the " +
  "buffer down to entries that arrived after the cutoff. Alice prefers " +
  "VS Code over Vim for large projects and ships at the end of the day.";

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM memory_segments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  getMemoryDb()!.run("DELETE FROM memory_jobs");

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

function messageRow(messageId: string) {
  return getDb()
    .select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
}

function segmentCountFor(messageId: string): number {
  return getDb()
    .select()
    .from(memorySegments)
    .where(eq(memorySegments.messageId, messageId))
    .all().length;
}

/** Memory-jobs of `type` whose payload references `messageId` (embed_segment
 *  payloads carry segment metadata, so those are matched by conversation-wide
 *  count instead — callers reset the table between saves). */
function jobCount(type: string): number {
  return getMemoryDb()!
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, type))
    .all().length;
}

function blocks(text: string): string {
  return JSON.stringify([{ type: "text", text }]);
}

beforeEach(() => {
  resetTables();
});

describe("addMessage skipIndexing contract", () => {
  test("skipIndexing: true persists the row but produces zero segments and zero tickets", async () => {
    const saved = await addMessage(CONVERSATION_ID, "user", blocks(LONG_TEXT), {
      skipIndexing: true,
    });

    // The row exists — the message is part of the transcript.
    expect(messageRow(saved.id)).toBeDefined();

    // No indexing artifacts of any kind.
    expect(segmentCountFor(saved.id)).toBe(0);
    expect(jobCount("embed_segment")).toBe(0);
    expect(jobCount("index_message_lexical")).toBe(0);
  });

  test("default save indexes: segments, embed tickets, and a lexical ticket", async () => {
    const saved = await addMessage(CONVERSATION_ID, "user", blocks(LONG_TEXT));

    expect(messageRow(saved.id)).toBeDefined();
    expect(segmentCountFor(saved.id)).toBeGreaterThan(0);
    expect(jobCount("embed_segment")).toBeGreaterThan(0);

    const lexicalPayloads = getMemoryDb()!
      .select({ payload: memoryJobs.payload })
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "index_message_lexical"))
      .all()
      .map((row) => JSON.parse(row.payload) as { messageId?: string });
    expect(lexicalPayloads).toEqual([{ messageId: saved.id }]);
  });

  test("a default-path save after a skipped save still indexes (per-message flag)", async () => {
    const skipped = await addMessage(
      CONVERSATION_ID,
      "user",
      blocks(LONG_TEXT),
      { skipIndexing: true },
    );
    const reply = await addMessage(
      CONVERSATION_ID,
      "assistant",
      blocks(LONG_TEXT),
    );

    expect(segmentCountFor(skipped.id)).toBe(0);
    expect(segmentCountFor(reply.id)).toBeGreaterThan(0);
    expect(jobCount("index_message_lexical")).toBe(1);
  });
});
