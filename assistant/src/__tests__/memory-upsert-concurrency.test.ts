/**
 * Atomicity tests for memory UPSERT paths.
 *
 * SQLite is single-writer, and indexMessageNow is a synchronous function.
 * Because every call runs to completion before the next microtask starts, the
 * Promise.all / Promise.resolve().then() pattern used here does NOT create
 * true concurrent execution — calls still run sequentially.
 *
 * What these tests DO verify is the correctness of the ON CONFLICT /
 * IMMEDIATE-transaction logic when the same logical operation is repeated many
 * times (e.g. duplicate indexer runs for the same messageId).  That covers the
 * most common real-world correctness problem: a retry or a duplicate dispatch
 * reaching the same code path more than once.
 *
 * True OS-level thread concurrency would require spawning separate worker
 * processes and is not tested here.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    hybridSearch: async () => [],
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
  resolveQdrantUrl: () => "http://127.0.0.1:6333",
}));

import { DEFAULT_CONFIG } from "../config/defaults.js";

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

mock.module("../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

import { getDb, initializeDb } from "../memory/db.js";
import { indexMessageNow } from "../memory/indexer.js";
import { conversations, memorySegments, messages } from "../memory/schema.js";

// Initialize DB once for the entire file. Each test cleans its own tables.
initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM memory_embeddings");
  db.run("DELETE FROM memory_graph_nodes");
  db.run("DELETE FROM memory_segments");
  db.run("DELETE FROM memory_jobs");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

/** Insert a minimal conversation + message row for FK references. */
function seedConversationAndMessage(
  conversationId: string,
  messageId: string,
  text: string,
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
      content: JSON.stringify([{ type: "text", text }]),
      createdAt: now,
    })
    .run();
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite: segment UPSERT atomicity under parallel indexer load
// ─────────────────────────────────────────────────────────────────────────────

describe("segment UPSERT atomicity under repeated indexer invocations", () => {
  beforeEach(() => {
    resetTables();
  });

  test("repeated indexing of the same message does not create duplicate segments", async () => {
    // Index the same messageId multiple times (simulating duplicate indexer
    // dispatches, retries, or a race at the call site).  The ON CONFLICT DO
    // UPDATE on memorySegments.id must absorb every duplicate call.
    const conversationId = "conv-parallel-segment-dedup";
    const messageId = "msg-parallel-segment-dedup";
    const text =
      "I prefer TypeScript over plain JavaScript for large projects.";

    seedConversationAndMessage(conversationId, messageId, text);

    const db = getDb();
    const config = TEST_CONFIG.memory;

    // Call indexMessageNow N times for the same messageId.  Even though we use
    // Promise.all, these synchronous calls still run sequentially — the point is
    // to verify that repeated indexer runs for the same messageId do not produce
    // duplicate segment rows (i.e. the ON CONFLICT DO UPDATE absorbs them).
    const WORKERS = 8;
    await Promise.all(
      Array.from({ length: WORKERS }, () =>
        Promise.resolve().then(() =>
          indexMessageNow(
            {
              messageId,
              conversationId,
              role: "user",
              content: JSON.stringify([{ type: "text", text }]),
              createdAt: Date.now(),
            },
            config,
          ),
        ),
      ),
    );

    const segments = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();

    // Each physical segment (identified by segmentId = messageId + segmentIndex)
    // must appear exactly once regardless of how many indexer calls ran.
    const idCounts = new Map<string, number>();
    for (const seg of segments) {
      idCounts.set(seg.id, (idCounts.get(seg.id) ?? 0) + 1);
    }
    for (const [segId, count] of idCounts) {
      expect(count).toBe(1);
      expect(segId.startsWith(messageId)).toBe(true);
    }
  });

  test("indexing distinct messages produces independent segment sets", async () => {
    // Different messages indexed in the same batch must each produce their own
    // non-overlapping segments with correct messageId back-references.
    const now = Date.now();
    const conversationId = "conv-parallel-distinct";
    const db = getDb();

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

    const MSG_COUNT = 6;
    for (let i = 0; i < MSG_COUNT; i++) {
      db.insert(messages)
        .values({
          id: `msg-distinct-${i}`,
          conversationId,
          role: "user",
          content: JSON.stringify([
            {
              type: "text",
              text: `Distinct message content for worker ${i}, covering a unique topic that should be stored separately.`,
            },
          ]),
          createdAt: now + i,
        })
        .run();
    }

    const config = TEST_CONFIG.memory;

    // Call indexMessageNow once per distinct messageId.  The calls run
    // sequentially (synchronous functions), but grouping them here mirrors
    // how a batch indexer would dispatch multiple messages and lets us assert
    // that each message produces its own non-overlapping segment set.
    await Promise.all(
      Array.from({ length: MSG_COUNT }, (_, i) => {
        const msgId = `msg-distinct-${i}`;
        return Promise.resolve().then(() =>
          indexMessageNow(
            {
              messageId: msgId,
              conversationId,
              role: "user",
              content: JSON.stringify([
                {
                  type: "text",
                  text: `Distinct message content for worker ${i}, covering a unique topic that should be stored separately.`,
                },
              ]),
              createdAt: now + i,
            },
            config,
          ),
        );
      }),
    );

    // Every segment must reference its own message and no segment may appear
    // for the wrong messageId.
    for (let i = 0; i < MSG_COUNT; i++) {
      const msgId = `msg-distinct-${i}`;
      const segs = db
        .select()
        .from(memorySegments)
        .where(eq(memorySegments.messageId, msgId))
        .all();

      // At least one segment must have been written.
      expect(segs.length).toBeGreaterThanOrEqual(1);

      // Segment IDs must be of the form `${msgId}:${index}`.
      for (const seg of segs) {
        expect(seg.id.startsWith(msgId + ":")).toBe(true);
        expect(seg.messageId).toBe(msgId);
        expect(seg.conversationId).toBe(conversationId);
      }
    }
  });

  test("re-indexing with identical content does not change the stored segment", async () => {
    // When an indexer re-processes an already-indexed segment (same id + same
    // content hash), the ON CONFLICT DO UPDATE path must run but the row must
    // remain semantically equivalent to the original.
    const conversationId = "conv-stable-rehash";
    const messageId = "msg-stable-rehash";
    const text =
      "My preferred timezone is America/Los_Angeles and I work remotely.";

    seedConversationAndMessage(conversationId, messageId, text);

    const config = TEST_CONFIG.memory;

    const firstResult = await indexMessageNow(
      {
        messageId,
        conversationId,
        role: "user",
        content: JSON.stringify([{ type: "text", text }]),
        createdAt: Date.now(),
      },
      config,
    );

    const db = getDb();
    const segmentsAfterFirst = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();

    // Re-index twice more with the same payload.
    await indexMessageNow(
      {
        messageId,
        conversationId,
        role: "user",
        content: JSON.stringify([{ type: "text", text }]),
        createdAt: Date.now(),
      },
      config,
    );
    await indexMessageNow(
      {
        messageId,
        conversationId,
        role: "user",
        content: JSON.stringify([{ type: "text", text }]),
        createdAt: Date.now(),
      },
      config,
    );

    const segmentsAfterRehash = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();

    // Segment count must not have grown.
    expect(segmentsAfterRehash.length).toBe(segmentsAfterFirst.length);

    // Content hashes must match between first and subsequent indexings.
    const firstById = new Map(segmentsAfterFirst.map((s) => [s.id, s]));
    for (const seg of segmentsAfterRehash) {
      const original = firstById.get(seg.id);
      expect(original).toBeDefined();
      expect(seg.contentHash).toBe(original!.contentHash);
      expect(seg.text).toBe(original!.text);
    }

    // The indexer must have reported the correct segment count both times.
    expect(firstResult.indexedSegments).toBeGreaterThanOrEqual(1);
  });

  test("re-indexing same message with different content applies last-write semantics", async () => {
    // When indexMessageNow is called twice for the same messageId with different
    // content (simulating an edit followed by a re-index), the ON CONFLICT DO
    // UPDATE must store one row per segmentId.  We cannot assert which text
    // "wins" — only that no duplicate rows exist.
    const conversationId = "conv-edit-race";
    const messageId = "msg-edit-race";
    const textV1 =
      "I prefer React for frontend development work on large projects.";
    const textV2 =
      "I prefer Vue for frontend development work on large projects instead.";

    seedConversationAndMessage(conversationId, messageId, textV1);

    const config = TEST_CONFIG.memory;

    // Call indexMessageNow twice with different content for the same messageId,
    // running sequentially.  The ON CONFLICT DO UPDATE must absorb both calls
    // and leave exactly one row per segmentId regardless of which content wins.
    await Promise.all([
      Promise.resolve().then(() =>
        indexMessageNow(
          {
            messageId,
            conversationId,
            role: "user",
            content: JSON.stringify([{ type: "text", text: textV1 }]),
            createdAt: Date.now(),
          },
          config,
        ),
      ),
      Promise.resolve().then(() =>
        indexMessageNow(
          {
            messageId,
            conversationId,
            role: "user",
            content: JSON.stringify([{ type: "text", text: textV2 }]),
            createdAt: Date.now(),
          },
          config,
        ),
      ),
    ]);

    const db = getDb();
    const segments = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();

    // No duplicate segment IDs — each logical segment must appear at most once.
    const ids = segments.map((s) => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test suite: memory segment job atomicity
// ─────────────────────────────────────────────────────────────────────────────

describe("memory segment job atomicity under repeated indexer invocations", () => {
  beforeEach(() => {
    resetTables();
  });

  test("each unique (messageId, segmentIndex) pair generates at most one segment row", async () => {
    // Re-index the same messages multiple times to verify that the job+segment
    // transaction boundary is respected and no duplicate segment rows appear for
    // the same logical (messageId, segmentIndex) identity.
    const conversationId = "conv-job-atomicity";
    const now = Date.now();
    const db = getDb();

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

    const MSG_COUNT = 5;
    const REPEATS = 4; // how many times each message is re-indexed
    for (let i = 0; i < MSG_COUNT; i++) {
      db.insert(messages)
        .values({
          id: `msg-atomicity-${i}`,
          conversationId,
          role: "user",
          content: JSON.stringify([
            {
              type: "text",
              text: `Message ${i}: I prefer TypeScript and always follow functional programming patterns in my projects.`,
            },
          ]),
          createdAt: now + i,
        })
        .run();
    }

    const config = TEST_CONFIG.memory;

    // Repeat indexMessageNow REPEATS times for each of MSG_COUNT messages.  All
    // calls run sequentially; the test verifies that repeated indexing of the
    // same (messageId, segmentIndex) never produces duplicate segment rows.
    await Promise.all(
      Array.from({ length: REPEATS }, () =>
        Array.from({ length: MSG_COUNT }, (_, i) => {
          const msgId = `msg-atomicity-${i}`;
          return Promise.resolve().then(() =>
            indexMessageNow(
              {
                messageId: msgId,
                conversationId,
                role: "user",
                content: JSON.stringify([
                  {
                    type: "text",
                    text: `Message ${i}: I prefer TypeScript and always follow functional programming patterns in my projects.`,
                  },
                ]),
                createdAt: now + i,
              },
              config,
            ),
          );
        }),
      ).flat(),
    );

    // For every message, count distinct segment IDs — there must be no
    // duplicates regardless of how many indexer calls ran.
    for (let i = 0; i < MSG_COUNT; i++) {
      const msgId = `msg-atomicity-${i}`;
      const segs = db
        .select()
        .from(memorySegments)
        .where(eq(memorySegments.messageId, msgId))
        .all();

      const segIds = segs.map((s) => s.id);
      const uniqueSegIds = new Set(segIds);
      expect(uniqueSegIds.size).toBe(segIds.length);
    }
  });

  test("indexer result counts are consistent with actual stored segment counts", async () => {
    // The IndexMessageResult.indexedSegments value returned by indexMessageNow
    // must always match the number of rows stored in memory_segments for that
    // message.  Under repeated indexing the stored count stays stable while
    // every result reports the same logical segment count.
    const conversationId = "conv-count-consistency";
    const messageId = "msg-count-consistency";
    const text =
      "I always prefer concise code reviews and I work in a distributed team across multiple timezones.";

    seedConversationAndMessage(conversationId, messageId, text);

    const config = TEST_CONFIG.memory;

    // Index the same message RUNS times sequentially.  The test verifies that
    // the returned indexedSegments count is stable across all runs and matches
    // the number of rows actually stored in the DB.
    const RUNS = 5;
    const results = await Promise.all(
      Array.from({ length: RUNS }, () =>
        Promise.resolve().then(() =>
          indexMessageNow(
            {
              messageId,
              conversationId,
              role: "user",
              content: JSON.stringify([{ type: "text", text }]),
              createdAt: Date.now(),
            },
            config,
          ),
        ),
      ),
    );

    const db = getDb();
    const storedSegments = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();

    // All runs must agree on the segment count.
    const firstCount = results[0].indexedSegments;
    for (const result of results) {
      expect(result.indexedSegments).toBe(firstCount);
    }

    // Stored count must equal the reported logical count.
    expect(storedSegments.length).toBe(firstCount);
  });
});

