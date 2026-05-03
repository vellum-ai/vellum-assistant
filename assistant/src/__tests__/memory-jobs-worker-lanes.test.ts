/**
 * Head-of-line repro for the per-lane scheduler in `runMemoryJobsOnce`.
 *
 * Before this fix, all non-embed jobs ran through a single bounded worker
 * pool, so a long-running `graph_consolidate` LLM call would pin every slot
 * and starve fast-lane jobs (e.g. `embed_concept_page` consolidation pages)
 * for the duration of that call.
 *
 * The new scheduler runs slow / fast / embed lanes in parallel pools, each
 * with its own concurrency budget. This test enqueues a wave of slow LLM
 * jobs alongside fast jobs and asserts that every fast job completes before
 * any slow job's promise resolves — proving the lanes are truly independent.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { AssistantConfig } from "../config/types.js";

// ── Mocks (must precede imports of tested module) ──────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Per-lane caps: 1 slow slot (so only 1 of the 5 enqueued slow jobs runs in
// this tick) and a generous fast cap so every fast job both gets claimed
// and gets a slot in the lane pool. The OLD shared-pool scheduler — which
// claimed jobs without lane awareness and ran them through a single
// workerConcurrency-sized pool — would pin its slots on the first claimed
// slow jobs and force the fast jobs to queue behind a 200ms LLM call.
const TEST_CONFIG: AssistantConfig = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    enabled: true,
    jobs: {
      ...DEFAULT_CONFIG.memory.jobs,
      slowLlmConcurrency: 1,
      fastConcurrency: 5,
      embedConcurrency: 1,
      workerConcurrency: 2,
    },
  },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => TEST_CONFIG,
  loadConfig: () => TEST_CONFIG,
  invalidateConfigCache: () => {},
}));

// ── Track timestamps so we can assert ordering ─────────────────────

type CompletionRecord = {
  type: string;
  conversationId: string;
  completedAt: number;
};
const completions: CompletionRecord[] = [];

// Slow-lane handler: blocks for SLOW_DELAY_MS. The test asserts every fast
// job completes before any slow job — a single 200ms window is plenty.
const SLOW_DELAY_MS = 200;

mock.module("../memory/graph/consolidation.js", () => ({
  runConsolidation: async (
    scopeId: string,
  ): Promise<{
    totalUpdated: number;
    totalDeleted: number;
    totalMergeEdges: number;
  }> => {
    await new Promise((resolve) => setTimeout(resolve, SLOW_DELAY_MS));
    completions.push({
      type: "graph_consolidate",
      conversationId: scopeId,
      completedAt: Date.now(),
    });
    return { totalUpdated: 0, totalDeleted: 0, totalMergeEdges: 0 };
  },
}));

// Fast-lane handler: resolves on the next microtask. The test fires this
// many times in parallel; nothing should block.
mock.module("../memory/jobs/embed-concept-page.js", () => ({
  embedConceptPageJob: async (job: {
    payload: { slug?: string };
  }): Promise<void> => {
    completions.push({
      type: "embed_concept_page",
      conversationId: job.payload.slug ?? "",
      completedAt: Date.now(),
    });
  },
}));

// Stub remaining heavy boundaries that we never exercise but that get pulled
// in transitively through jobs-worker's eager imports. These aren't strictly
// required if the host machine can resolve them, but mocking them keeps the
// test hermetic and fast under `bun test`.
mock.module("../memory/db-maintenance.js", () => ({
  maybeRunDbMaintenance: () => {},
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { enqueueMemoryJob } from "../memory/jobs-store.js";
import { runMemoryJobsOnce } from "../memory/jobs-worker.js";
import { _resetQdrantBreaker } from "../memory/qdrant-circuit-breaker.js";
import { memoryJobs } from "../memory/schema.js";

describe("memory jobs worker lane scheduling", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_jobs");
    completions.length = 0;
    _resetQdrantBreaker();
  });

  test("fast lane completes before slow lane releases its slot", async () => {
    // 5 slow `graph_consolidate` jobs across distinct scopes (so they would
    // serialize behind a single shared pool) plus 5 fast `embed_concept_page`
    // jobs across distinct slugs.
    for (let i = 0; i < 5; i++) {
      enqueueMemoryJob("graph_consolidate", { scopeId: `slow-${i}` });
    }
    for (let i = 0; i < 5; i++) {
      enqueueMemoryJob("embed_concept_page", { slug: `fast-${i}` });
    }

    await runMemoryJobsOnce();

    const fastDone = completions.filter((c) => c.type === "embed_concept_page");
    const slowDone = completions.filter((c) => c.type === "graph_consolidate");

    // Slow lane is capped at 1 in this test, so only 1 slow job ran in this
    // tick. Fast lane has cap 2, but with 5 fast jobs it runs all 5 because
    // each handler resolves on the next microtask.
    expect(fastDone).toHaveLength(5);
    expect(slowDone).toHaveLength(1);

    // Head-of-line guarantee: every fast completion timestamp must precede
    // the (single) slow completion timestamp. Under the old shared pool with
    // workerConcurrency=2 and 1 slow slot occupied, this still held only if
    // a fast slot freed up first — but with 2 slow jobs in flight (the old
    // claim path would have claimed multiple slow jobs into the shared pool)
    // both slots would be pinned for SLOW_DELAY_MS and fast work would queue
    // behind. With the lane scheduler, fast work has its own pool.
    const earliestSlow = Math.min(...slowDone.map((c) => c.completedAt));
    for (const fast of fastDone) {
      expect(fast.completedAt).toBeLessThan(earliestSlow);
    }

    // Sanity: exactly 1 of the 5 enqueued slow jobs reached `completed` (the
    // slow lane's per-tick budget). The other 4 are still pending and will be
    // picked up on subsequent ticks. (FIFO ordering inside the slow lane is
    // covered separately in jobs-store-qdrant-breaker.test.ts.)
    //
    // Note: a sixth `graph_consolidate` row may also appear here — the
    // `maybeEnqueueGraphMaintenanceJobs` tail of `runMemoryJobsOnce` enqueues
    // its own maintenance job whose checkpoint is missing in this fresh DB.
    // That row is irrelevant; we only care about the completed-vs-pending
    // counts of jobs we explicitly seeded.
    const completedSlow = countSlowByStatus("completed");
    expect(completedSlow).toBe(1);
  });
});

function countSlowByStatus(
  status: "pending" | "running" | "completed",
): number {
  const db = getDb();
  return db
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, "graph_consolidate"))
    .all()
    .filter((row) => row.status === status).length;
}
