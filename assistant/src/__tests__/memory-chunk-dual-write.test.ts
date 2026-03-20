/**
 * Tests for the chunk write path in the memory indexer.
 *
 * The indexer writes archive memory_chunks (legacy memory_segments are no
 * longer produced). These tests verify:
 *
 * 1. Chunks are created with correct boundaries and content.
 * 2. Unchanged chunk content does not enqueue duplicate embed_chunk jobs.
 * 3. Changed chunk content enqueues an embed_chunk job.
 * 4. Legacy embed_segment and extract_items jobs are no longer enqueued.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

const testDir = mkdtempSync(join(tmpdir(), "memory-chunk-dual-write-"));

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

mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    hybridSearch: async () => [],
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
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

import { getDb, initializeDb, resetDb, resetTestTables } from "../memory/db.js";
import { indexMessageNow } from "../memory/indexer.js";
import {
  conversations,
  memoryChunks,
  memoryJobs,
  memoryObservations,
  messages,
} from "../memory/schema.js";

// Initialize DB once for the entire file. Each test cleans its own tables.
initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    // best effort cleanup
  }
});

function resetTables() {
  resetTestTables(
    "memory_chunks",
    "memory_observations",
    "memory_segments",
    "memory_jobs",
    "messages",
    "conversations",
  );
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
    })
    .onConflictDoNothing()
    .run();

  db.insert(messages)
    .values({
      id: messageId,
      conversationId,
      role: "user",
      content: JSON.stringify([{ type: "text", text }]),
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite: chunk writes (legacy segment production removed)
// ─────────────────────────────────────────────────────────────────────────────

describe("chunk writes from the memory indexer", () => {
  beforeEach(() => {
    resetTables();
  });

  test("indexing a message creates observation and chunks", async () => {
    const conversationId = "conv-dual-write-basic";
    const messageId = "msg-dual-write-basic";
    const text =
      "I prefer TypeScript for large projects and always use strict mode.";

    seedConversationAndMessage(conversationId, messageId, text);

    const config = TEST_CONFIG.memory;
    const result = await indexMessageNow(
      {
        messageId,
        conversationId,
        role: "user",
        content: JSON.stringify([{ type: "text", text }]),
        createdAt: Date.now(),
      },
      config,
    );

    expect(result.indexedSegments).toBeGreaterThanOrEqual(1);

    const db = getDb();

    // Verify chunks were created
    const observationId = `obs:${messageId}`;
    const chunks = db
      .select()
      .from(memoryChunks)
      .where(eq(memoryChunks.observationId, observationId))
      .all();
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    // Verify the observation was created
    const observation = db
      .select()
      .from(memoryObservations)
      .where(eq(memoryObservations.id, observationId))
      .get();
    expect(observation).toBeDefined();
    expect(observation!.conversationId).toBe(conversationId);
    expect(observation!.messageId).toBe(messageId);
    expect(observation!.role).toBe("user");

    // Verify chunk content is populated
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `chunk:${messageId}:${i}`;
      const chunk = chunks.find((c) => c.id === chunkId);
      expect(chunk).toBeDefined();
      expect(chunk!.content.length).toBeGreaterThan(0);
      expect(chunk!.tokenEstimate).toBeGreaterThan(0);
    }
  });

  test("unchanged chunk content does not enqueue duplicate embed_chunk jobs", async () => {
    const conversationId = "conv-unchanged-chunk";
    const messageId = "msg-unchanged-chunk";
    const text =
      "My preferred timezone is America/Los_Angeles and I work remotely.";

    seedConversationAndMessage(conversationId, messageId, text);

    const config = TEST_CONFIG.memory;
    const content = JSON.stringify([{ type: "text", text }]);

    // First indexing — should enqueue embed_chunk jobs
    await indexMessageNow(
      {
        messageId,
        conversationId,
        role: "user",
        content,
        createdAt: Date.now(),
      },
      config,
    );

    const db = getDb();
    const jobsAfterFirst = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "embed_chunk"))
      .all();
    const firstChunkJobCount = jobsAfterFirst.length;
    expect(firstChunkJobCount).toBeGreaterThanOrEqual(1);

    // Second indexing with identical content — should NOT enqueue more embed_chunk jobs
    await indexMessageNow(
      {
        messageId,
        conversationId,
        role: "user",
        content,
        createdAt: Date.now(),
      },
      config,
    );

    const jobsAfterSecond = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "embed_chunk"))
      .all();

    // No new embed_chunk jobs should have been enqueued
    expect(jobsAfterSecond.length).toBe(firstChunkJobCount);
  });

  test("changed chunk content enqueues new embed_chunk jobs", async () => {
    const conversationId = "conv-changed-chunk";
    const messageId = "msg-changed-chunk";
    const textV1 = "I prefer React for frontend development work.";
    const textV2 =
      "I prefer Vue for frontend development work on large projects instead.";

    seedConversationAndMessage(conversationId, messageId, textV1);

    const config = TEST_CONFIG.memory;

    // First indexing
    await indexMessageNow(
      {
        messageId,
        conversationId,
        role: "user",
        content: JSON.stringify([{ type: "text", text: textV1 }]),
        createdAt: Date.now(),
      },
      config,
    );

    const db = getDb();
    const jobsAfterFirst = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "embed_chunk"))
      .all();
    const firstChunkJobCount = jobsAfterFirst.length;
    expect(firstChunkJobCount).toBeGreaterThanOrEqual(1);

    // Second indexing with DIFFERENT content — should enqueue new embed_chunk jobs
    await indexMessageNow(
      {
        messageId,
        conversationId,
        role: "user",
        content: JSON.stringify([{ type: "text", text: textV2 }]),
        createdAt: Date.now(),
      },
      config,
    );

    const jobsAfterSecond = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "embed_chunk"))
      .all();

    // New embed_chunk jobs should have been enqueued for the changed content
    expect(jobsAfterSecond.length).toBeGreaterThan(firstChunkJobCount);
  });

  test("legacy jobs are no longer enqueued", async () => {
    const conversationId = "conv-no-legacy-jobs";
    const messageId = "msg-no-legacy-jobs";
    const text =
      "I always prefer concise code reviews and I work in a distributed team.";

    seedConversationAndMessage(conversationId, messageId, text);

    const config = TEST_CONFIG.memory;
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

    const db = getDb();

    // No legacy embed_segment jobs
    const segmentJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "embed_segment"))
      .all();
    expect(segmentJobs).toHaveLength(0);

    // No legacy extract_items jobs
    const extractJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "extract_items"))
      .all();
    expect(extractJobs).toHaveLength(0);

    // No legacy build_conversation_summary jobs
    const summaryJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "build_conversation_summary"))
      .all();
    expect(summaryJobs).toHaveLength(0);

    // embed_chunk jobs ARE still enqueued (new archive path)
    const chunkJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "embed_chunk"))
      .all();
    expect(chunkJobs.length).toBeGreaterThanOrEqual(1);
  });

  test("repeated indexing produces stable chunk count with unique IDs", async () => {
    const conversationId = "conv-chunk-dedup";
    const messageId = "msg-chunk-dedup";
    const text =
      "I prefer TypeScript over plain JavaScript for large projects.";

    seedConversationAndMessage(conversationId, messageId, text);

    const config = TEST_CONFIG.memory;
    const content = JSON.stringify([{ type: "text", text }]);

    // Index the same message once to get the baseline chunk count
    const firstResult = await indexMessageNow(
      {
        messageId,
        conversationId,
        role: "user",
        content,
        createdAt: Date.now(),
      },
      config,
    );

    const db = getDb();
    const observationId = `obs:${messageId}`;

    const chunksAfterFirst = db
      .select()
      .from(memoryChunks)
      .where(eq(memoryChunks.observationId, observationId))
      .all();
    const baselineChunkCount = chunksAfterFirst.length;
    expect(baselineChunkCount).toBe(firstResult.indexedSegments);

    // Index the same message multiple more times
    for (let i = 0; i < 4; i++) {
      await indexMessageNow(
        {
          messageId,
          conversationId,
          role: "user",
          content,
          createdAt: Date.now(),
        },
        config,
      );
    }

    // Verify no duplicate chunks — count stays the same
    const chunks = db
      .select()
      .from(memoryChunks)
      .where(eq(memoryChunks.observationId, observationId))
      .all();
    expect(chunks.length).toBe(baselineChunkCount);

    // Verify chunk IDs are unique
    const chunkIds = chunks.map((c) => c.id);
    const uniqueChunkIds = new Set(chunkIds);
    expect(uniqueChunkIds.size).toBe(chunkIds.length);
  });

  test("chunk dual-write respects custom scopeId", async () => {
    const conversationId = "conv-scope";
    const messageId = "msg-scope";
    const text = "Custom scoped message content.";
    const scopeId = "custom-scope-42";

    seedConversationAndMessage(conversationId, messageId, text);

    const config = TEST_CONFIG.memory;
    await indexMessageNow(
      {
        messageId,
        conversationId,
        role: "user",
        content: JSON.stringify([{ type: "text", text }]),
        createdAt: Date.now(),
        scopeId,
      },
      config,
    );

    const db = getDb();
    const observationId = `obs:${messageId}`;

    const observation = db
      .select()
      .from(memoryObservations)
      .where(eq(memoryObservations.id, observationId))
      .get();
    expect(observation!.scopeId).toBe(scopeId);

    const chunks = db
      .select()
      .from(memoryChunks)
      .where(eq(memoryChunks.observationId, observationId))
      .all();
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      expect(chunk.scopeId).toBe(scopeId);
    }
  });
});
