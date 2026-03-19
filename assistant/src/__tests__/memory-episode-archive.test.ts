/**
 * Tests for episode archive store insertion helpers and embed_episode job dispatch.
 *
 * Verifies:
 * - Episode rows can be inserted via compaction and resolution helpers
 * - embed_episode jobs are enqueued on insertion
 * - embed_episode dispatches correctly through the jobs worker
 */
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

import { DEFAULT_CONFIG } from "../config/defaults.js";

const testDir = mkdtempSync(join(tmpdir(), "memory-episode-archive-"));

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

// Track embedAndUpsert calls to verify embedding dispatch without needing a real backend
const embedCalls: Array<{
  targetType: string;
  targetId: string;
  text: string;
  extraPayload: Record<string, unknown>;
}> = [];

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realJobUtils = require("../memory/job-utils.js");
mock.module("../memory/job-utils.js", () => ({
  ...realJobUtils,
  embedAndUpsert: async (
    _config: unknown,
    targetType: string,
    targetId: string,
    text: string,
    extraPayload: Record<string, unknown>,
  ) => {
    embedCalls.push({ targetType, targetId, text, extraPayload });
  },
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

const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    embeddings: {
      ...DEFAULT_CONFIG.memory.embeddings,
      provider: "openai" as const,
      required: false,
    },
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

import {
  insertCompactionEpisode,
  insertResolutionEpisode,
} from "../memory/archive-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { claimMemoryJobs, enqueueMemoryJob } from "../memory/jobs-store.js";
import { runMemoryJobsOnce } from "../memory/jobs-worker.js";
import { conversations, memoryEpisodes, memoryJobs } from "../memory/schema.js";

describe("episode archive store", () => {
  const now = 1_710_000_000_000;
  const convId = "conv-episode-test";

  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.delete(memoryJobs).run();
    db.delete(memoryEpisodes).run();
    db.delete(conversations).run();
    embedCalls.length = 0;

    // Seed a conversation for FK references
    db.insert(conversations)
      .values({
        id: convId,
        title: null,
        createdAt: now,
        updatedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        contextSummary: null,
        contextCompactedMessageCount: 0,
      })
      .run();
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best effort
    }
  });

  // ── Insertion helpers ───────────────────────────────────────────────

  test("insertCompactionEpisode inserts an episode row", () => {
    const { episodeId } = insertCompactionEpisode({
      conversationId: convId,
      title: "Morning standup discussion",
      summary: "User discussed project blockers and timeline updates",
      tokenEstimate: 42,
      source: "vellum",
      startAt: now - 60_000,
      endAt: now,
    });

    const db = getDb();
    const episode = db
      .select()
      .from(memoryEpisodes)
      .where(eq(memoryEpisodes.id, episodeId))
      .get();

    expect(episode).not.toBeNull();
    expect(episode!.conversationId).toBe(convId);
    expect(episode!.title).toBe("Morning standup discussion");
    expect(episode!.summary).toBe(
      "User discussed project blockers and timeline updates",
    );
    expect(episode!.tokenEstimate).toBe(42);
    expect(episode!.source).toBe("vellum");
    expect(episode!.startAt).toBe(now - 60_000);
    expect(episode!.endAt).toBe(now);
    expect(episode!.scopeId).toBe("default");
  });

  test("insertResolutionEpisode inserts an episode row", () => {
    const { episodeId } = insertResolutionEpisode({
      conversationId: convId,
      title: "Full conversation summary",
      summary: "A complete discussion about project architecture decisions",
      tokenEstimate: 100,
      startAt: now - 3_600_000,
      endAt: now,
    });

    const db = getDb();
    const episode = db
      .select()
      .from(memoryEpisodes)
      .where(eq(memoryEpisodes.id, episodeId))
      .get();

    expect(episode).not.toBeNull();
    expect(episode!.title).toBe("Full conversation summary");
    expect(episode!.source).toBeNull();
  });

  test("insertCompactionEpisode respects custom scopeId", () => {
    const { episodeId } = insertCompactionEpisode({
      scopeId: "project-alpha",
      conversationId: convId,
      title: "Scoped episode",
      summary: "Testing scope assignment",
      tokenEstimate: 10,
      startAt: now,
      endAt: now,
    });

    const db = getDb();
    const episode = db
      .select()
      .from(memoryEpisodes)
      .where(eq(memoryEpisodes.id, episodeId))
      .get();

    expect(episode!.scopeId).toBe("project-alpha");
  });

  // ── Job enqueue ──────────────────────────────────────────────────

  test("insertCompactionEpisode enqueues an embed_episode job", () => {
    const { episodeId, jobId } = insertCompactionEpisode({
      conversationId: convId,
      title: "Job test",
      summary: "Verifying job enqueue",
      tokenEstimate: 5,
      startAt: now,
      endAt: now,
    });

    expect(jobId).toBeTruthy();

    const db = getDb();
    const job = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, jobId))
      .get();

    expect(job).not.toBeNull();
    expect(job!.type).toBe("embed_episode");
    expect(job!.status).toBe("pending");

    const payload = JSON.parse(job!.payload);
    expect(payload.episodeId).toBe(episodeId);
  });

  test("insertResolutionEpisode enqueues an embed_episode job", () => {
    const { episodeId, jobId } = insertResolutionEpisode({
      conversationId: convId,
      title: "Resolution job test",
      summary: "Verifying resolution job enqueue",
      tokenEstimate: 8,
      startAt: now - 1000,
      endAt: now,
    });

    expect(jobId).toBeTruthy();

    const db = getDb();
    const job = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, jobId))
      .get();

    expect(job).not.toBeNull();
    expect(job!.type).toBe("embed_episode");

    const payload = JSON.parse(job!.payload);
    expect(payload.episodeId).toBe(episodeId);
  });

  // ── Worker dispatch ──────────────────────────────────────────────

  test("embed_episode jobs are claimed and dispatched through the worker", async () => {
    const { episodeId } = insertCompactionEpisode({
      conversationId: convId,
      title: "Worker dispatch test",
      summary: "Verifying worker dispatches embed_episode correctly",
      tokenEstimate: 15,
      source: "telegram",
      startAt: now - 30_000,
      endAt: now,
    });

    const processed = await runMemoryJobsOnce();
    expect(processed).toBe(1);

    // The mock embedAndUpsert should have been called with "episode" targetType
    expect(embedCalls.length).toBe(1);
    expect(embedCalls[0]!.targetType).toBe("episode");
    expect(embedCalls[0]!.targetId).toBe(episodeId);
    expect(embedCalls[0]!.text).toContain("[episode]");
    expect(embedCalls[0]!.text).toContain("Worker dispatch test");
    expect(embedCalls[0]!.extraPayload.conversation_id).toBe(convId);
    expect(embedCalls[0]!.extraPayload.memory_scope_id).toBe("default");
  });

  test("embed_episode job is classified as an embed job type for scheduling priority", () => {
    // Verify that embed_episode jobs are claimed alongside other embed jobs
    // by enqueuing both an embed_episode and checking claim behavior
    enqueueMemoryJob("embed_episode", { episodeId: "nonexistent" });

    const jobs = claimMemoryJobs(10);
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.type).toBe("embed_episode");
  });

  // ── Multiple episodes per conversation ────────────────────────────

  test("multiple episodes can be inserted for the same conversation", () => {
    const { episodeId: ep1 } = insertCompactionEpisode({
      conversationId: convId,
      title: "First compaction",
      summary: "First block of turns",
      tokenEstimate: 20,
      startAt: now - 120_000,
      endAt: now - 60_000,
    });

    const { episodeId: ep2 } = insertCompactionEpisode({
      conversationId: convId,
      title: "Second compaction",
      summary: "Second block of turns",
      tokenEstimate: 25,
      startAt: now - 60_000,
      endAt: now,
    });

    const { episodeId: ep3 } = insertResolutionEpisode({
      conversationId: convId,
      title: "Final resolution",
      summary: "Full conversation narrative",
      tokenEstimate: 50,
      startAt: now - 120_000,
      endAt: now,
    });

    expect(ep1).not.toBe(ep2);
    expect(ep2).not.toBe(ep3);

    const db = getDb();
    const episodes = db
      .select()
      .from(memoryEpisodes)
      .where(eq(memoryEpisodes.conversationId, convId))
      .all();

    expect(episodes.length).toBe(3);

    // All three should have enqueued embed jobs
    const jobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "embed_episode"))
      .all();

    expect(jobs.length).toBe(3);
  });
});
