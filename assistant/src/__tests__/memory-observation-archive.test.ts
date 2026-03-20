import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "memory-observation-archive-test-"));
const dbPath = join(testDir, "test.db");

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => dbPath,
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { eq } from "drizzle-orm";

import {
  computeObservationContentHash,
  getChunkByObservationId,
  getObservation,
  insertObservation,
  type InsertObservationParams,
  insertObservations,
} from "../memory/archive-store.js";
import { getDb, initializeDb, rawAll, resetDb } from "../memory/db.js";
import { claimMemoryJobs } from "../memory/jobs-store.js";
import { conversations, memoryChunks, messages } from "../memory/schema.js";

function removeTestDbFiles(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

// ── Helpers ─────────────────────────────────────────────────────────

function createConversation(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function createMessage(id: string, conversationId: string): void {
  const db = getDb();
  db.insert(messages)
    .values({
      id,
      conversationId,
      role: "user",
      content: "test message",
      createdAt: Date.now(),
    })
    .run();
}

function getJobsByType(type: string) {
  return rawAll<{
    id: string;
    type: string;
    payload: string;
    status: string;
  }>(`SELECT id, type, payload, status FROM memory_jobs WHERE type = ?`, type);
}

// ── Setup ───────────────────────────────────────────────────────────

describe("memory observation archive store", () => {
  beforeEach(() => {
    resetDb();
    removeTestDbFiles();
    initializeDb();
  });

  afterEach(() => {
    resetDb();
    removeTestDbFiles();
  });

  afterAll(() => {
    resetDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── Row insertion ───────────────────────────────────────────────

  describe("insertObservation", () => {
    test("inserts observation row into memory_observations table", () => {
      createConversation("conv-1");

      const result = insertObservation({
        conversationId: "conv-1",
        role: "user",
        content: "The user prefers dark mode",
      });

      expect(result.observationId).toBeTruthy();
      expect(result.contentHash).toBeTruthy();

      const obs = getObservation(result.observationId);
      expect(obs).toBeDefined();
      expect(obs!.conversationId).toBe("conv-1");
      expect(obs!.role).toBe("user");
      expect(obs!.content).toBe("The user prefers dark mode");
      expect(obs!.modality).toBe("text");
      expect(obs!.scopeId).toBe("default");
    });

    test("inserts associated chunk with correct content hash", () => {
      createConversation("conv-1");

      const result = insertObservation({
        conversationId: "conv-1",
        role: "user",
        content: "The user lives in NYC",
      });

      expect(result.chunkId).toBeTruthy();

      const chunk = getChunkByObservationId(result.observationId);
      expect(chunk).toBeDefined();
      expect(chunk!.content).toBe("The user lives in NYC");
      expect(chunk!.contentHash).toBe(result.contentHash);
      expect(chunk!.tokenEstimate).toBeGreaterThan(0);
      expect(chunk!.scopeId).toBe("default");
    });

    test("respects optional params: scopeId, modality, source, messageId", () => {
      createConversation("conv-1");
      createMessage("msg-1", "conv-1");

      const result = insertObservation({
        conversationId: "conv-1",
        messageId: "msg-1",
        role: "assistant",
        content: "Voice observation about weather",
        scopeId: "custom-scope",
        modality: "voice",
        source: "phone",
      });

      const obs = getObservation(result.observationId);
      expect(obs).toBeDefined();
      expect(obs!.messageId).toBe("msg-1");
      expect(obs!.scopeId).toBe("custom-scope");
      expect(obs!.modality).toBe("voice");
      expect(obs!.source).toBe("phone");
    });

    test("does not touch legacy memory tables", () => {
      createConversation("conv-1");

      insertObservation({
        conversationId: "conv-1",
        role: "user",
        content: "A fact about the user",
      });

      // Verify no rows in legacy memory_segments or memory_items
      const segments = rawAll<{ id: string }>(`SELECT id FROM memory_segments`);
      const items = rawAll<{ id: string }>(`SELECT id FROM memory_items`);
      expect(segments).toHaveLength(0);
      expect(items).toHaveLength(0);
    });
  });

  // ── Content hash idempotency ──────────────────────────────────

  describe("content hash idempotency", () => {
    test("duplicate content in same scope does not create a second chunk", () => {
      createConversation("conv-1");

      const result1 = insertObservation({
        conversationId: "conv-1",
        role: "user",
        content: "The user likes cats",
      });

      const result2 = insertObservation({
        conversationId: "conv-1",
        role: "user",
        content: "The user likes cats",
      });

      // Both observations should exist
      expect(getObservation(result1.observationId)).toBeDefined();
      expect(getObservation(result2.observationId)).toBeDefined();

      // First creates a chunk, second is deduplicated
      expect(result1.chunkId).toBeTruthy();
      expect(result2.chunkId).toBeNull();

      // Only one chunk row should exist
      const db = getDb();
      const chunks = db
        .select()
        .from(memoryChunks)
        .where(eq(memoryChunks.scopeId, "default"))
        .all();
      expect(chunks).toHaveLength(1);
    });

    test("same content in different scopes creates separate chunks", () => {
      createConversation("conv-1");

      const result1 = insertObservation({
        conversationId: "conv-1",
        role: "user",
        content: "The user likes dogs",
        scopeId: "scope-a",
      });

      const result2 = insertObservation({
        conversationId: "conv-1",
        role: "user",
        content: "The user likes dogs",
        scopeId: "scope-b",
      });

      expect(result1.chunkId).toBeTruthy();
      expect(result2.chunkId).toBeTruthy();
      expect(result1.chunkId).not.toBe(result2.chunkId);
    });

    test("content hashes are deterministic", () => {
      const hash1 = computeObservationContentHash("default", "Hello world");
      const hash2 = computeObservationContentHash("default", "Hello world");
      expect(hash1).toBe(hash2);

      // Different scope produces different hash
      const hash3 = computeObservationContentHash("other", "Hello world");
      expect(hash1).not.toBe(hash3);
    });
  });

  // ── Embedding job dispatch ────────────────────────────────────

  describe("embedding job dispatch", () => {
    test("enqueues embed_observation job when new chunk is created", () => {
      createConversation("conv-1");

      const result = insertObservation({
        conversationId: "conv-1",
        role: "user",
        content: "User prefers TypeScript",
      });

      expect(result.embeddingJobId).toBeTruthy();

      const jobs = getJobsByType("embed_observation");
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe("pending");

      const payload = JSON.parse(jobs[0].payload);
      expect(payload.observationId).toBe(result.observationId);
      expect(payload.chunkId).toBe(result.chunkId);
    });

    test("does not enqueue embed job when chunk is deduplicated", () => {
      createConversation("conv-1");

      // First insert creates a chunk and job
      insertObservation({
        conversationId: "conv-1",
        role: "user",
        content: "User prefers Python",
      });

      // Second insert with same content should not create another job
      const result2 = insertObservation({
        conversationId: "conv-1",
        role: "user",
        content: "User prefers Python",
      });

      expect(result2.embeddingJobId).toBeNull();

      const jobs = getJobsByType("embed_observation");
      expect(jobs).toHaveLength(1); // Only from the first insert
    });

    test("embed_observation jobs are claimable by the worker", () => {
      createConversation("conv-1");

      insertObservation({
        conversationId: "conv-1",
        role: "user",
        content: "Claimable observation",
      });

      const claimed = claimMemoryJobs(10);
      const embedJobs = claimed.filter((j) => j.type === "embed_observation");
      expect(embedJobs).toHaveLength(1);
      expect(embedJobs[0].status).toBe("running");
      expect(embedJobs[0].payload.observationId).toBeTruthy();
      expect(embedJobs[0].payload.chunkId).toBeTruthy();
    });
  });

  // ── Batch insertion ───────────────────────────────────────────

  describe("insertObservations (batch)", () => {
    test("inserts multiple observations atomically", () => {
      createConversation("conv-1");

      const params: InsertObservationParams[] = [
        { conversationId: "conv-1", role: "user", content: "Fact A" },
        { conversationId: "conv-1", role: "user", content: "Fact B" },
        { conversationId: "conv-1", role: "assistant", content: "Fact C" },
      ];

      const results = insertObservations(params);
      expect(results).toHaveLength(3);

      // All observations should exist
      for (const result of results) {
        expect(getObservation(result.observationId)).toBeDefined();
      }

      // All should have chunks (different content)
      for (const result of results) {
        expect(result.chunkId).toBeTruthy();
      }

      // All should have embedding jobs
      const jobs = getJobsByType("embed_observation");
      expect(jobs).toHaveLength(3);
    });

    test("batch handles content hash dedup within the batch", () => {
      createConversation("conv-1");

      const params: InsertObservationParams[] = [
        { conversationId: "conv-1", role: "user", content: "Same content" },
        { conversationId: "conv-1", role: "user", content: "Same content" },
      ];

      const results = insertObservations(params);
      expect(results).toHaveLength(2);

      // First creates a chunk, second is deduplicated
      expect(results[0].chunkId).toBeTruthy();
      expect(results[1].chunkId).toBeNull();

      // Only one embedding job
      const jobs = getJobsByType("embed_observation");
      expect(jobs).toHaveLength(1);
    });
  });
});
