/**
 * Tests for the chunk dual-write path in the memory indexer.
 *
 * The indexer now writes both legacy memory_segments AND archive
 * memory_chunks using the same segmentation boundaries. These tests
 * verify:
 *
 * 1. Chunks are created alongside segments with matching boundaries.
 * 2. Unchanged chunk content does not enqueue duplicate embed_chunk jobs.
 * 3. Changed chunk content enqueues an embed_chunk job.
 * 4. The legacy memory_segments path remains intact.
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
  memorySegments,
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
// Test suite: chunk dual-write alongside legacy segments
// ─────────────────────────────────────────────────────────────────────────────

describe("chunk dual-write from the memory indexer", () => {
  beforeEach(() => {
    resetTables();
  });

  test("indexing a message creates chunks alongside segments with matching boundaries", async () => {
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

    // Verify segments were created (legacy path)
    const segments = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();
    expect(segments.length).toBeGreaterThanOrEqual(1);

    // Verify chunks were created (dual-write path)
    const observationId = `obs:${messageId}`;
    const chunks = db
      .select()
      .from(memoryChunks)
      .where(eq(memoryChunks.observationId, observationId))
      .all();
    expect(chunks.length).toBe(segments.length);

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

    // Verify chunk content matches segment content (same boundaries)
    for (let i = 0; i < segments.length; i++) {
      const chunkId = `chunk:${messageId}:${i}`;
      const chunk = chunks.find((c) => c.id === chunkId);
      expect(chunk).toBeDefined();
      expect(chunk!.content).toBe(segments[i].text);
      expect(chunk!.tokenEstimate).toBe(segments[i].tokenEstimate);
      expect(chunk!.scopeId).toBe(segments[i].scopeId);
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

  test("legacy memory_segments path remains intact", async () => {
    const conversationId = "conv-legacy-compat";
    const messageId = "msg-legacy-compat";
    const text =
      "I always prefer concise code reviews and I work in a distributed team.";

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

    const db = getDb();

    // Legacy segments must be present and correctly formed
    const segments = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();
    expect(segments.length).toBe(result.indexedSegments);

    for (const seg of segments) {
      expect(seg.id.startsWith(messageId + ":")).toBe(true);
      expect(seg.conversationId).toBe(conversationId);
      expect(seg.role).toBe("user");
      expect(seg.text.length).toBeGreaterThan(0);
      expect(seg.contentHash).toBeTruthy();
    }

    // Legacy embed_segment jobs must be enqueued
    const segmentJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "embed_segment"))
      .all();
    expect(segmentJobs.length).toBeGreaterThanOrEqual(1);
  });

  test("repeated indexing produces exactly one chunk per segment boundary", async () => {
    const conversationId = "conv-chunk-dedup";
    const messageId = "msg-chunk-dedup";
    const text =
      "I prefer TypeScript over plain JavaScript for large projects.";

    seedConversationAndMessage(conversationId, messageId, text);

    const config = TEST_CONFIG.memory;
    const content = JSON.stringify([{ type: "text", text }]);

    // Index the same message multiple times
    for (let i = 0; i < 5; i++) {
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

    const db = getDb();
    const observationId = `obs:${messageId}`;

    // Verify no duplicate chunks — one chunk per segment boundary
    const chunks = db
      .select()
      .from(memoryChunks)
      .where(eq(memoryChunks.observationId, observationId))
      .all();
    const segments = db
      .select()
      .from(memorySegments)
      .where(eq(memorySegments.messageId, messageId))
      .all();

    expect(chunks.length).toBe(segments.length);

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
