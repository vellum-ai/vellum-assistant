import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { eq } from "drizzle-orm";

const testDir = mkdtempSync(join(tmpdir(), "memory-chunk-archive-test-"));

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

// Track calls to embedAndUpsert
const embedAndUpsertCalls: Array<{
  config: unknown;
  targetType: string;
  targetId: string;
  input: unknown;
  extraPayload: unknown;
}> = [];

mock.module("../memory/job-utils.js", () => ({
  asString: (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : null,
  embedAndUpsert: async (
    config: unknown,
    targetType: string,
    targetId: string,
    input: unknown,
    extraPayload: unknown,
  ) => {
    embedAndUpsertCalls.push({
      config,
      targetType,
      targetId,
      input,
      extraPayload,
    });
  },
}));

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { AssistantConfig } from "../config/types.js";
import {
  computeChunkContentHash,
  estimateTokens,
  getChunkById,
  getChunksByObservationId,
  upsertChunk,
  upsertChunks,
} from "../memory/archive-store.js";
import { getDb, initializeDb, resetTestTables } from "../memory/db.js";
import { embedChunkJob } from "../memory/job-handlers/embedding.js";
import type { MemoryJob } from "../memory/jobs-store.js";
import {
  conversations,
  memoryJobs,
  memoryObservations,
} from "../memory/schema.js";

const TEST_CONFIG: AssistantConfig = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
    },
  },
};

// ── Helpers ─────────────────────────────────────────────────────────

function makeJob(payload: Record<string, unknown>): MemoryJob {
  return {
    id: "job-1",
    type: "embed_chunk",
    payload,
    status: "running",
    attempts: 0,
    deferrals: 0,
    runAfter: 0,
    lastError: null,
    startedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function seedConversation(id = "conv-1"): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title: "Test Conversation",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
}

function seedObservation(
  id = "obs-1",
  conversationId = "conv-1",
  content = "The user prefers dark mode.",
): void {
  const db = getDb();
  const now = Date.now();
  db.insert(memoryObservations)
    .values({
      id,
      scopeId: "default",
      conversationId,
      role: "user",
      content,
      modality: "text",
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
}

// ── Tests ───────────────────────────────────────────────────────────

describe("archive-store chunk helpers", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    embedAndUpsertCalls.length = 0;
    // Clear tables in FK-dependency order: chunks → observations → jobs, conversations
    resetTestTables(
      "memory_chunks",
      "memory_observations",
      "memory_jobs",
      "conversations",
    );
    seedConversation();
    seedObservation();
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── computeChunkContentHash ─────────────────────────────────────

  describe("computeChunkContentHash", () => {
    test("produces deterministic hash for same inputs", () => {
      const h1 = computeChunkContentHash("default", "hello world");
      const h2 = computeChunkContentHash("default", "hello world");
      expect(h1).toBe(h2);
    });

    test("produces different hash for different scope", () => {
      const h1 = computeChunkContentHash("default", "hello world");
      const h2 = computeChunkContentHash("other-scope", "hello world");
      expect(h1).not.toBe(h2);
    });

    test("produces different hash for different content", () => {
      const h1 = computeChunkContentHash("default", "hello world");
      const h2 = computeChunkContentHash("default", "goodbye world");
      expect(h1).not.toBe(h2);
    });
  });

  // ── estimateTokens ─────────────────────────────────────────────

  describe("estimateTokens", () => {
    test("returns at least 1 for empty string", () => {
      expect(estimateTokens("")).toBe(1);
    });

    test("estimates roughly 4 chars per token", () => {
      const text = "a".repeat(100);
      expect(estimateTokens(text)).toBe(25);
    });
  });

  // ── upsertChunk ────────────────────────────────────────────────

  describe("upsertChunk", () => {
    test("inserts a new chunk and enqueues embed_chunk job", () => {
      const result = upsertChunk({
        observationId: "obs-1",
        content: "The user prefers dark mode.",
      });

      expect(result.inserted).toBe(true);
      expect(result.chunkId).toBeTruthy();

      // Verify chunk row exists
      const chunk = getChunkById(result.chunkId);
      expect(chunk).toBeDefined();
      expect(chunk!.content).toBe("The user prefers dark mode.");
      expect(chunk!.scopeId).toBe("default");
      expect(chunk!.observationId).toBe("obs-1");
      expect(chunk!.tokenEstimate).toBeGreaterThan(0);

      // Verify embed_chunk job was enqueued
      const db = getDb();
      const jobs = db
        .select()
        .from(memoryJobs)
        .where(eq(memoryJobs.type, "embed_chunk"))
        .all();
      expect(jobs).toHaveLength(1);
      const payload = JSON.parse(jobs[0].payload);
      expect(payload.chunkId).toBe(result.chunkId);
      expect(payload.scopeId).toBe("default");
    });

    test("skips insert when content hash already exists (idempotence)", () => {
      const first = upsertChunk({
        observationId: "obs-1",
        content: "The user prefers dark mode.",
      });
      expect(first.inserted).toBe(true);

      const second = upsertChunk({
        observationId: "obs-1",
        content: "The user prefers dark mode.",
      });
      expect(second.inserted).toBe(false);
      expect(second.chunkId).toBe(first.chunkId);

      // Only one embed_chunk job should exist
      const db = getDb();
      const jobs = db
        .select()
        .from(memoryJobs)
        .where(eq(memoryJobs.type, "embed_chunk"))
        .all();
      expect(jobs).toHaveLength(1);
    });

    test("inserts different chunks for different content", () => {
      const r1 = upsertChunk({
        observationId: "obs-1",
        content: "Chunk A content",
      });
      const r2 = upsertChunk({
        observationId: "obs-1",
        content: "Chunk B content",
      });

      expect(r1.inserted).toBe(true);
      expect(r2.inserted).toBe(true);
      expect(r1.chunkId).not.toBe(r2.chunkId);
    });

    test("respects custom scopeId", () => {
      const result = upsertChunk({
        scopeId: "scope-42",
        observationId: "obs-1",
        content: "Scoped content",
      });

      const chunk = getChunkById(result.chunkId);
      expect(chunk!.scopeId).toBe("scope-42");
    });

    test("uses provided tokenEstimate when given", () => {
      const result = upsertChunk({
        observationId: "obs-1",
        content: "Short text",
        tokenEstimate: 99,
      });

      const chunk = getChunkById(result.chunkId);
      expect(chunk!.tokenEstimate).toBe(99);
    });
  });

  // ── upsertChunks (batch) ──────────────────────────────────────

  describe("upsertChunks", () => {
    test("upserts multiple chunks and returns results in order", () => {
      const results = upsertChunks([
        { observationId: "obs-1", content: "First chunk" },
        { observationId: "obs-1", content: "Second chunk" },
        { observationId: "obs-1", content: "Third chunk" },
      ]);

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.inserted)).toBe(true);

      // All chunk IDs are unique
      const ids = new Set(results.map((r) => r.chunkId));
      expect(ids.size).toBe(3);
    });

    test("batch upsert with duplicate content is idempotent", () => {
      const results = upsertChunks([
        { observationId: "obs-1", content: "Same content" },
        { observationId: "obs-1", content: "Same content" },
      ]);

      expect(results[0].inserted).toBe(true);
      expect(results[1].inserted).toBe(false);
      expect(results[0].chunkId).toBe(results[1].chunkId);
    });
  });

  // ── getChunksByObservationId ──────────────────────────────────

  describe("getChunksByObservationId", () => {
    test("returns all chunks for an observation", () => {
      upsertChunk({ observationId: "obs-1", content: "Chunk A" });
      upsertChunk({ observationId: "obs-1", content: "Chunk B" });

      const chunks = getChunksByObservationId("obs-1");
      expect(chunks).toHaveLength(2);
    });

    test("returns empty array for unknown observation", () => {
      const chunks = getChunksByObservationId("obs-nonexistent");
      expect(chunks).toHaveLength(0);
    });
  });

  // ── embedChunkJob ─────────────────────────────────────────────

  describe("embedChunkJob", () => {
    test("skips when chunkId is missing from payload", async () => {
      await embedChunkJob(makeJob({}), TEST_CONFIG);
      expect(embedAndUpsertCalls).toHaveLength(0);
    });

    test("skips when chunk is not found", async () => {
      await embedChunkJob(makeJob({ chunkId: "nonexistent" }), TEST_CONFIG);
      expect(embedAndUpsertCalls).toHaveLength(0);
    });

    test("embeds chunk with correct targetType and payload", async () => {
      const result = upsertChunk({
        observationId: "obs-1",
        content: "The user prefers dark mode.",
      });

      await embedChunkJob(makeJob({ chunkId: result.chunkId }), TEST_CONFIG);

      expect(embedAndUpsertCalls).toHaveLength(1);
      const call = embedAndUpsertCalls[0];
      expect(call.targetType).toBe("chunk");
      expect(call.targetId).toBe(result.chunkId);
      expect(call.input).toBe("The user prefers dark mode.");
      expect(call.extraPayload).toMatchObject({
        observation_id: "obs-1",
        memory_scope_id: "default",
      });
      expect(
        (call.extraPayload as Record<string, unknown>).created_at,
      ).toBeGreaterThan(0);
    });

    test("embeds chunk with correct scopeId in extra payload", async () => {
      const result = upsertChunk({
        scopeId: "custom-scope",
        observationId: "obs-1",
        content: "Scoped chunk content.",
      });

      await embedChunkJob(makeJob({ chunkId: result.chunkId }), TEST_CONFIG);

      expect(embedAndUpsertCalls).toHaveLength(1);
      const call = embedAndUpsertCalls[0];
      expect(
        (call.extraPayload as Record<string, unknown>).memory_scope_id,
      ).toBe("custom-scope");
    });
  });
});
