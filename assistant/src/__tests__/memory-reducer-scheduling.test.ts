import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Test directory & platform mocks ───────────────────────────────

const testDir = mkdtempSync(join(tmpdir(), "reducer-scheduling-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  getRootDir: () => testDir,
  getWorkspaceDir: () => join(testDir, "workspace"),
  getConversationsDir: () => join(testDir, "workspace", "conversations"),
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

// ── Config mock — controllable idleDelayMs ───────────────────────

let mockIdleDelayMs = 30_000;

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    memory: {
      simplified: {
        reducer: {
          idleDelayMs: mockIdleDelayMs,
          switchWaitMs: 5_000,
        },
      },
    },
  }),
  loadConfig: () => ({
    memory: {
      simplified: {
        reducer: {
          idleDelayMs: mockIdleDelayMs,
          switchWaitMs: 5_000,
        },
      },
    },
  }),
}));

// ── Suppress disk-view side effects ──────────────────────────────

mock.module("../memory/conversation-disk-view.js", () => ({
  initConversationDir: () => {},
  removeConversationDir: () => {},
  syncMessageToDisk: () => {},
  updateMetaFile: () => {},
}));

// ── Suppress indexer side effects ────────────────────────────────

mock.module("../memory/indexer.js", () => ({
  indexMessageNow: async () => {},
}));

// ── Suppress attention side effects ──────────────────────────────

mock.module("../memory/conversation-attention-store.js", () => ({
  projectAssistantMessage: () => {},
  seedForkedConversationAttention: () => {},
}));

// ── Imports (after mocks) ─────────────────────────────────────────

import {
  markConversationMemoryDirty,
  scheduleReducerJob,
  sweepStaleReducerJobs,
} from "../memory/conversation-crud.js";
import { initializeDb, resetDb } from "../memory/db.js";
import { getSqlite } from "../memory/db-connection.js";
import { resetTestTables } from "../memory/raw-query.js";

initializeDb();

// ── Helpers ───────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

function insertConversation(
  id: string,
  opts?: {
    dirtyTailMessageId?: string | null;
    createdAt?: number;
  },
): void {
  const raw = getSqlite();
  raw.run(
    `INSERT INTO conversations (id, title, created_at, updated_at, conversation_type, source, memory_scope_id, is_auto_title,
       memory_dirty_tail_since_message_id)
     VALUES (?, 'Test', ?, ?, 'standard', 'user', 'default', 1, ?)`,
    [
      id,
      opts?.createdAt ?? NOW,
      opts?.createdAt ?? NOW,
      opts?.dirtyTailMessageId ?? null,
    ],
  );
}

function insertMessage(opts: {
  id: string;
  conversationId: string;
  role?: string;
  content?: string;
  createdAt?: number;
}): void {
  const raw = getSqlite();
  raw.run(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.conversationId,
      opts.role ?? "user",
      opts.content ?? "test message",
      opts.createdAt ?? NOW,
    ],
  );
}

function getReducerJobs(
  conversationId: string,
): Array<Record<string, unknown>> {
  const raw = getSqlite();
  return raw
    .query(
      `SELECT * FROM memory_jobs
       WHERE type = 'reduce_conversation_memory'
         AND json_extract(payload, '$.conversationId') = ?
       ORDER BY created_at ASC`,
    )
    .all(conversationId) as Array<Record<string, unknown>>;
}

function insertReducerJob(
  conversationId: string,
  opts?: { status?: string; runAfter?: number },
): void {
  const raw = getSqlite();
  const now = Date.now();
  raw.run(
    `INSERT INTO memory_jobs (id, type, payload, status, attempts, deferrals, run_after, created_at, updated_at)
     VALUES (?, 'reduce_conversation_memory', ?, ?, 0, 0, ?, ?, ?)`,
    [
      `job-${conversationId}-${now}`,
      JSON.stringify({ conversationId }),
      opts?.status ?? "pending",
      opts?.runAfter ?? now + 30_000,
      now,
      now,
    ],
  );
}

// ── Teardown ──────────────────────────────────────────────────────

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

beforeEach(() => {
  resetTestTables("messages", "conversations", "memory_jobs");
  mockIdleDelayMs = 30_000;
});

// ── Tests ─────────────────────────────────────────────────────────

describe("markConversationMemoryDirty — reducer job scheduling", () => {
  test("creates a pending reducer job on first dirty mark", () => {
    insertConversation("conv-1");
    insertMessage({ id: "msg-1", conversationId: "conv-1" });

    markConversationMemoryDirty("conv-1", "msg-1");

    const jobs = getReducerJobs("conv-1");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("pending");
    expect(jobs[0].type).toBe("reduce_conversation_memory");
  });

  test("schedules reducer job with idleDelayMs offset from now", () => {
    mockIdleDelayMs = 60_000;
    insertConversation("conv-1");
    insertMessage({ id: "msg-1", conversationId: "conv-1" });

    const before = Date.now();
    markConversationMemoryDirty("conv-1", "msg-1");
    const after = Date.now();

    const jobs = getReducerJobs("conv-1");
    expect(jobs).toHaveLength(1);
    const runAfter = jobs[0].run_after as number;
    // runAfter should be approximately now + 60_000
    expect(runAfter).toBeGreaterThanOrEqual(before + 60_000);
    expect(runAfter).toBeLessThanOrEqual(after + 60_000);
  });

  test("deduplicates: second mark does not create a second job", () => {
    insertConversation("conv-1");
    insertMessage({ id: "msg-1", conversationId: "conv-1" });
    insertMessage({
      id: "msg-2",
      conversationId: "conv-1",
      createdAt: NOW + 1000,
    });

    markConversationMemoryDirty("conv-1", "msg-1");
    markConversationMemoryDirty("conv-1", "msg-2");

    const jobs = getReducerJobs("conv-1");
    expect(jobs).toHaveLength(1);
  });

  test("reschedules: second mark pushes runAfter forward", () => {
    mockIdleDelayMs = 10_000;
    insertConversation("conv-1");
    insertMessage({ id: "msg-1", conversationId: "conv-1" });

    markConversationMemoryDirty("conv-1", "msg-1");
    const jobs1 = getReducerJobs("conv-1");
    const firstRunAfter = jobs1[0].run_after as number;

    // Simulate a short delay before the next message
    const pauseMs = 50;
    Bun.sleepSync(pauseMs);

    insertMessage({
      id: "msg-2",
      conversationId: "conv-1",
      createdAt: NOW + 5000,
    });
    markConversationMemoryDirty("conv-1", "msg-2");

    const jobs2 = getReducerJobs("conv-1");
    expect(jobs2).toHaveLength(1);
    const secondRunAfter = jobs2[0].run_after as number;
    // The second runAfter should be later than the first
    expect(secondRunAfter).toBeGreaterThan(firstRunAfter);
  });

  test("creates separate jobs for different conversations", () => {
    insertConversation("conv-1");
    insertConversation("conv-2");
    insertMessage({ id: "msg-1", conversationId: "conv-1" });
    insertMessage({ id: "msg-2", conversationId: "conv-2" });

    markConversationMemoryDirty("conv-1", "msg-1");
    markConversationMemoryDirty("conv-2", "msg-2");

    const jobs1 = getReducerJobs("conv-1");
    const jobs2 = getReducerJobs("conv-2");
    expect(jobs1).toHaveLength(1);
    expect(jobs2).toHaveLength(1);
    // They should be different job rows
    expect(jobs1[0].id).not.toBe(jobs2[0].id);
  });

  test("does not reschedule completed or failed jobs", () => {
    insertConversation("conv-1");
    insertMessage({ id: "msg-1", conversationId: "conv-1" });

    // Insert a completed job for this conversation
    insertReducerJob("conv-1", { status: "completed" });

    markConversationMemoryDirty("conv-1", "msg-1");

    // Should create a new pending job (not reuse the completed one)
    const jobs = getReducerJobs("conv-1");
    const pendingJobs = jobs.filter((j) => j.status === "pending");
    expect(pendingJobs).toHaveLength(1);
  });

  test("does not reschedule running jobs", () => {
    insertConversation("conv-1");
    insertMessage({ id: "msg-1", conversationId: "conv-1" });

    // Insert a running job for this conversation
    insertReducerJob("conv-1", { status: "running" });

    markConversationMemoryDirty("conv-1", "msg-1");

    // Should create a new pending job since we only look at pending for rescheduling
    const jobs = getReducerJobs("conv-1");
    const pendingJobs = jobs.filter((j) => j.status === "pending");
    expect(pendingJobs).toHaveLength(1);
  });
});

describe("scheduleReducerJob — explicit runAfter override", () => {
  test("accepts a custom runAfter timestamp", () => {
    insertConversation("conv-1");

    const customRunAfter = NOW + 999_999;
    scheduleReducerJob("conv-1", customRunAfter);

    const jobs = getReducerJobs("conv-1");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].run_after).toBe(customRunAfter);
  });
});

describe("sweepStaleReducerJobs — startup sweep", () => {
  test("enqueues immediate jobs for stale dirty conversations", () => {
    mockIdleDelayMs = 30_000;
    const oldTime = Date.now() - 60_000; // Well past idle delay

    insertConversation("conv-1", { dirtyTailMessageId: "msg-1" });
    insertMessage({
      id: "msg-1",
      conversationId: "conv-1",
      createdAt: oldTime,
    });

    const count = sweepStaleReducerJobs();

    expect(count).toBe(1);
    const jobs = getReducerJobs("conv-1");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("pending");
    // Should be scheduled for immediate execution (runAfter <= now)
    expect(jobs[0].run_after as number).toBeLessThanOrEqual(Date.now());
  });

  test("skips conversations that are not dirty", () => {
    const oldTime = Date.now() - 60_000;

    // Not dirty — no dirtyTailMessageId
    insertConversation("conv-1");
    insertMessage({
      id: "msg-1",
      conversationId: "conv-1",
      createdAt: oldTime,
    });

    const count = sweepStaleReducerJobs();
    expect(count).toBe(0);
    expect(getReducerJobs("conv-1")).toHaveLength(0);
  });

  test("skips dirty conversations whose tail is within the idle window", () => {
    mockIdleDelayMs = 30_000;
    const recentTime = Date.now() - 5_000; // Only 5s ago, within idle delay

    insertConversation("conv-1", { dirtyTailMessageId: "msg-1" });
    insertMessage({
      id: "msg-1",
      conversationId: "conv-1",
      createdAt: recentTime,
    });

    const count = sweepStaleReducerJobs();
    expect(count).toBe(0);
    expect(getReducerJobs("conv-1")).toHaveLength(0);
  });

  test("skips conversations that already have a pending reducer job", () => {
    mockIdleDelayMs = 30_000;
    const oldTime = Date.now() - 60_000;

    insertConversation("conv-1", { dirtyTailMessageId: "msg-1" });
    insertMessage({
      id: "msg-1",
      conversationId: "conv-1",
      createdAt: oldTime,
    });
    insertReducerJob("conv-1", { status: "pending" });

    const count = sweepStaleReducerJobs();
    expect(count).toBe(0);
    // Only the pre-existing job should be there
    const jobs = getReducerJobs("conv-1");
    expect(jobs).toHaveLength(1);
  });

  test("skips conversations that have a running reducer job", () => {
    mockIdleDelayMs = 30_000;
    const oldTime = Date.now() - 60_000;

    insertConversation("conv-1", { dirtyTailMessageId: "msg-1" });
    insertMessage({
      id: "msg-1",
      conversationId: "conv-1",
      createdAt: oldTime,
    });
    insertReducerJob("conv-1", { status: "running" });

    const count = sweepStaleReducerJobs();
    expect(count).toBe(0);
  });

  test("sweeps multiple stale conversations", () => {
    mockIdleDelayMs = 30_000;
    const oldTime = Date.now() - 60_000;

    insertConversation("conv-1", { dirtyTailMessageId: "msg-1" });
    insertMessage({
      id: "msg-1",
      conversationId: "conv-1",
      createdAt: oldTime,
    });

    insertConversation("conv-2", { dirtyTailMessageId: "msg-2" });
    insertMessage({
      id: "msg-2",
      conversationId: "conv-2",
      createdAt: oldTime - 1000,
    });

    const count = sweepStaleReducerJobs();
    expect(count).toBe(2);
    expect(getReducerJobs("conv-1")).toHaveLength(1);
    expect(getReducerJobs("conv-2")).toHaveLength(1);
  });

  test("only enqueues for stale conversations in a mixed set", () => {
    mockIdleDelayMs = 30_000;
    const oldTime = Date.now() - 60_000;
    const recentTime = Date.now() - 5_000;

    // Stale dirty conversation
    insertConversation("conv-stale", { dirtyTailMessageId: "msg-1" });
    insertMessage({
      id: "msg-1",
      conversationId: "conv-stale",
      createdAt: oldTime,
    });

    // Recent dirty conversation (within idle window)
    insertConversation("conv-recent", { dirtyTailMessageId: "msg-2" });
    insertMessage({
      id: "msg-2",
      conversationId: "conv-recent",
      createdAt: recentTime,
    });

    // Clean conversation
    insertConversation("conv-clean");
    insertMessage({
      id: "msg-3",
      conversationId: "conv-clean",
      createdAt: oldTime,
    });

    const count = sweepStaleReducerJobs();
    expect(count).toBe(1);
    expect(getReducerJobs("conv-stale")).toHaveLength(1);
    expect(getReducerJobs("conv-recent")).toHaveLength(0);
    expect(getReducerJobs("conv-clean")).toHaveLength(0);
  });
});
