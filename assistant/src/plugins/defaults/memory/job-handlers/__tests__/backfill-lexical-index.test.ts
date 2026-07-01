import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { SparseEmbedding } from "../../../../../persistence/embeddings/embedding-types.js";

mock.module("../../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Capture the batched upserts into the lexical index singleton.
const upsertBatchCalls: Array<
  Array<{
    messageId: string;
    sparse: SparseEmbedding;
    conversationId: string;
    createdAt: number;
  }>
> = [];

const fakeIndex = {
  upsertMessagesBatch: async (
    points: Array<{
      messageId: string;
      sparse: SparseEmbedding;
      conversationId: string;
      createdAt: number;
    }>,
  ) => {
    upsertBatchCalls.push(points);
  },
};

// Model the process-local singleton so `resolveLexicalIndex` resolves the fake
// index without a real Qdrant client.
let singletonReady = true;

function resetLexicalSingleton(ready: boolean): void {
  singletonReady = ready;
}

mock.module(
  "../../../../../persistence/embeddings/messages-lexical-index.js",
  () => ({
    MESSAGES_LEXICAL_COLLECTION: "messages_lexical",
    getMessagesLexicalIndex: () => {
      if (!singletonReady) {
        throw new Error("Messages lexical index not initialized.");
      }
      return fakeIndex;
    },
    initMessagesLexicalIndex: () => {
      singletonReady = true;
      return fakeIndex;
    },
  }),
);

// `withQdrantBreaker` just invokes the operation in tests — replace it with a
// pass-through so the breaker's timing/state machinery stays out of the way.
mock.module(
  "../../../../../persistence/embeddings/qdrant-circuit-breaker.js",
  () => ({
    withQdrantBreaker: <T>(op: () => Promise<T>) => op(),
  }),
);

// `generateSparseEmbedding` is a pure local TF-IDF encoder (no provider call),
// so it runs unmocked — mocking `embedding-backend.js` wholesale would starve
// its other named exports that the db-init import graph pulls in.
import { resetDbForTesting } from "../../../../../__tests__/db-test-helpers.js";
import { DEFAULT_CONFIG } from "../../../../../config/defaults.js";
import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "../../../../../config/loader.js";
import type { AssistantConfig } from "../../../../../config/types.js";
import {
  deleteMemoryCheckpoint,
  isLexicalBackfillComplete,
  LEXICAL_BACKFILL_COMPLETE_KEY,
  readMessageCursorCheckpoint,
  resetMessageCursorCheckpoint,
  setMemoryCheckpoint,
  writeMessageCursorCheckpoint,
} from "../../../../../persistence/checkpoints.js";
import {
  getDb,
  getMemoryDb,
} from "../../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../../persistence/db-init.js";
import { generateSparseEmbedding } from "../../../../../persistence/embeddings/embedding-backend.js";
import type { MemoryJob } from "../../../../../persistence/jobs-store.js";
import {
  conversations,
  memoryJobs,
  messages,
} from "../../../../../persistence/schema/index.js";
import {
  backfillLexicalIndexJob,
  maybeEnqueueLexicalBackfillOnUpgrade,
} from "../backfill-lexical-index.js";

const TEST_CONFIG: AssistantConfig = DEFAULT_CONFIG;

const CHECKPOINT_KEY = "lexical:messages:last_created_at";
const CHECKPOINT_ID_KEY = "lexical:messages:last_id";

function makeJob(payload: Record<string, unknown>): MemoryJob {
  return {
    id: "job-1",
    type: "backfill_lexical_index",
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

function insertConversation(id: string): void {
  const now = Date.now();
  getDb()
    .insert(conversations)
    .values({ id, createdAt: now, updatedAt: now })
    .run();
}

function insertMessage(opts: {
  id: string;
  conversationId: string;
  content: string;
  createdAt: number;
}): void {
  getDb()
    .insert(messages)
    .values({
      id: opts.id,
      conversationId: opts.conversationId,
      role: "user",
      content: opts.content,
      createdAt: opts.createdAt,
    })
    .run();
}

/** Count pending `backfill_lexical_index` jobs enqueued in the memory DB. */
function pendingBackfillJobCount(): number {
  const rows = getMemoryDb()!
    .select({ id: memoryJobs.id })
    .from(memoryJobs)
    .all();
  return rows.length;
}

/**
 * Toggle `memory.enabled` in the real workspace config so the startup hook's
 * `isMemoryEnabled()` (which reads `getConfig()`) sees the change. Driving the
 * real config instead of mocking `jobs-store` avoids a process-global
 * `mock.module` leaking `isMemoryEnabled` into sibling test files.
 */
function setMemoryEnabled(enabled: boolean): void {
  const raw = loadRawConfig();
  const memory =
    raw.memory && typeof raw.memory === "object"
      ? (raw.memory as Record<string, unknown>)
      : {};
  saveRawConfig({ ...raw, memory: { ...memory, enabled } });
  invalidateConfigCache();
}

describe("backfillLexicalIndexJob", () => {
  // initializeDb runs the full migration chain; under parallel CI load it can
  // exceed bun's default 5s hook timeout, so allow more.
  beforeAll(async () => {
    await initializeDb();
  }, 30_000);

  beforeEach(async () => {
    upsertBatchCalls.length = 0;
    resetLexicalSingleton(true);
    setMemoryEnabled(true);
    resetDbForTesting();
    await initializeDb();
    // The template-restore path leaves stale WAL sidecars, so rows can bleed
    // across tests. This backfill scans the whole `messages` table, so clear
    // the tables and cursor it reads/writes to guarantee per-test isolation.
    getDb().delete(messages).run();
    getDb().delete(conversations).run();
    getMemoryDb()!.delete(memoryJobs).run();
    resetMessageCursorCheckpoint(CHECKPOINT_KEY, CHECKPOINT_ID_KEY);
    deleteMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY);
  }, 30_000);

  test("indexes a batch of messages and advances the checkpoint", async () => {
    insertConversation("conv-1");
    insertMessage({
      id: "msg-a",
      conversationId: "conv-1",
      content: "first lexical message",
      createdAt: 1_000,
    });
    insertMessage({
      id: "msg-b",
      conversationId: "conv-1",
      content: "second lexical message",
      createdAt: 2_000,
    });

    await backfillLexicalIndexJob(makeJob({}), TEST_CONFIG);

    // One batched upsert carrying both messages in (createdAt asc, id asc) order.
    expect(upsertBatchCalls).toHaveLength(1);
    const batch = upsertBatchCalls[0];
    expect(batch.map((p) => p.messageId)).toEqual(["msg-a", "msg-b"]);
    expect(batch[0].sparse).toEqual(
      generateSparseEmbedding("first lexical message"),
    );
    expect(batch[0].conversationId).toBe("conv-1");
    expect(batch[0].createdAt).toBe(1_000);

    // Cursor advanced to the last message in the batch.
    const cursor = readMessageCursorCheckpoint(
      CHECKPOINT_KEY,
      CHECKPOINT_ID_KEY,
    );
    expect(cursor).toEqual({ createdAt: 2_000, messageId: "msg-b" });

    // A short batch does not re-enqueue, and marks the backfill complete.
    expect(pendingBackfillJobCount()).toBe(0);
    expect(isLexicalBackfillComplete()).toBe(true);
  });

  test("resumes from the persisted cursor, skipping already-indexed rows", async () => {
    insertConversation("conv-2");
    insertMessage({
      id: "msg-old",
      conversationId: "conv-2",
      content: "already indexed",
      createdAt: 1_000,
    });
    insertMessage({
      id: "msg-new",
      conversationId: "conv-2",
      content: "not yet indexed",
      createdAt: 2_000,
    });

    // Pretend the first message was already indexed by a prior invocation.
    writeMessageCursorCheckpoint(CHECKPOINT_KEY, CHECKPOINT_ID_KEY, {
      createdAt: 1_000,
      messageId: "msg-old",
    });

    await backfillLexicalIndexJob(makeJob({}), TEST_CONFIG);

    expect(upsertBatchCalls).toHaveLength(1);
    expect(upsertBatchCalls[0].map((p) => p.messageId)).toEqual(["msg-new"]);
  });

  test("re-enqueues itself when the batch is full", async () => {
    insertConversation("conv-3");
    // 200 messages == BATCH_SIZE, so the job re-enqueues to continue draining.
    for (let i = 0; i < 200; i++) {
      insertMessage({
        id: `msg-${String(i).padStart(4, "0")}`,
        conversationId: "conv-3",
        content: `message number ${i}`,
        createdAt: 1_000 + i,
      });
    }

    await backfillLexicalIndexJob(makeJob({}), TEST_CONFIG);

    expect(upsertBatchCalls).toHaveLength(1);
    expect(upsertBatchCalls[0]).toHaveLength(200);
    // Exactly one follow-up job enqueued to process the remaining rows.
    expect(pendingBackfillJobCount()).toBe(1);
    // A full batch means more rows may remain, so the backfill is NOT yet
    // complete — the completion marker must stay unset until a short batch.
    expect(isLexicalBackfillComplete()).toBe(false);
  });

  test("does nothing (no upsert, no re-enqueue) when there are no messages, and marks complete", async () => {
    await backfillLexicalIndexJob(makeJob({}), TEST_CONFIG);
    expect(upsertBatchCalls).toHaveLength(0);
    expect(pendingBackfillJobCount()).toBe(0);
    // An empty batch is a drained backfill (an already-empty or fully-indexed
    // table) — the completion marker is written.
    expect(isLexicalBackfillComplete()).toBe(true);
  });

  test("force resets the cursor and re-indexes from the beginning", async () => {
    insertConversation("conv-4");
    insertMessage({
      id: "msg-x",
      conversationId: "conv-4",
      content: "reindex me",
      createdAt: 5_000,
    });

    // A stale cursor past every row would normally skip everything, and a prior
    // run had already marked the backfill complete.
    writeMessageCursorCheckpoint(CHECKPOINT_KEY, CHECKPOINT_ID_KEY, {
      createdAt: 9_999,
      messageId: "msg-zzz",
    });
    setMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY, "1");

    await backfillLexicalIndexJob(makeJob({ force: true }), TEST_CONFIG);

    // force reset the cursor to the origin, so the message is re-indexed.
    expect(upsertBatchCalls).toHaveLength(1);
    expect(upsertBatchCalls[0].map((p) => p.messageId)).toEqual(["msg-x"]);

    // Cursor now points at the last re-indexed message, not the stale value.
    const cursor = readMessageCursorCheckpoint(
      CHECKPOINT_KEY,
      CHECKPOINT_ID_KEY,
    );
    expect(cursor).toEqual({ createdAt: 5_000, messageId: "msg-x" });

    // force cleared the completion marker; the short re-index batch then drained
    // and re-marked it complete.
    expect(isLexicalBackfillComplete()).toBe(true);
  });

  test("force clears the completion marker even when the re-run does not drain in one batch", async () => {
    insertConversation("conv-force-full");
    // A full batch on the forced run: the marker must be CLEARED (re-armed) and
    // stay unset because more rows may remain past this batch.
    for (let i = 0; i < 200; i++) {
      insertMessage({
        id: `fm-${String(i).padStart(4, "0")}`,
        conversationId: "conv-force-full",
        content: `forced message ${i}`,
        createdAt: 1_000 + i,
      });
    }
    setMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY, "1");

    await backfillLexicalIndexJob(makeJob({ force: true }), TEST_CONFIG);

    expect(upsertBatchCalls[0]).toHaveLength(200);
    expect(pendingBackfillJobCount()).toBe(1);
    // Marker was cleared by force and not re-set (batch was full → more remain).
    expect(isLexicalBackfillComplete()).toBe(false);
  });

  test("lazily initializes the index when not yet initialized (worker process)", async () => {
    // Simulate the out-of-process worker, which never runs runMemoryStartup —
    // the singleton is not initialized in this process.
    resetLexicalSingleton(false);

    insertConversation("conv-w");
    insertMessage({
      id: "msg-w",
      conversationId: "conv-w",
      content: "indexed by the worker",
      createdAt: 1_000,
    });

    await backfillLexicalIndexJob(makeJob({}), TEST_CONFIG);

    // The handler initialized the index from config instead of throwing.
    expect(upsertBatchCalls).toHaveLength(1);
    expect(upsertBatchCalls[0].map((p) => p.messageId)).toEqual(["msg-w"]);
  });

  // The one-time startup auto-enqueue. Inherits the outer beforeEach, which
  // resets the DB, clears the memory_jobs table and completion marker, and sets
  // memoryEnabled = true — so each test starts from a fresh, memory-enabled,
  // never-backfilled instance.
  describe("maybeEnqueueLexicalBackfillOnUpgrade", () => {
    test("enqueues exactly one backfill job when memory is enabled and the checkpoint is unset", () => {
      maybeEnqueueLexicalBackfillOnUpgrade();

      const rows = getMemoryDb()!
        .select({ type: memoryJobs.type })
        .from(memoryJobs)
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe("backfill_lexical_index");
    });

    test("does NOT enqueue when the completion checkpoint is already set", () => {
      setMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY, "1");

      maybeEnqueueLexicalBackfillOnUpgrade();

      expect(pendingBackfillJobCount()).toBe(0);
    });

    test("does NOT enqueue when memory is disabled", () => {
      setMemoryEnabled(false);

      maybeEnqueueLexicalBackfillOnUpgrade();

      expect(pendingBackfillJobCount()).toBe(0);
    });

    test("does NOT enqueue a duplicate when a backfill job is already pending", () => {
      // First call enqueues the one-time job.
      maybeEnqueueLexicalBackfillOnUpgrade();
      expect(pendingBackfillJobCount()).toBe(1);

      // A second call (e.g. a restart mid-backfill) must not pile on a duplicate
      // while the prior job is still pending.
      maybeEnqueueLexicalBackfillOnUpgrade();
      expect(pendingBackfillJobCount()).toBe(1);
    });
  });
});
