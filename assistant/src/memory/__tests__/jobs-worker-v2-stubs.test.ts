/**
 * Stub-handler dispatch tests for the remaining memory v2 job types whose
 * production handler hasn't landed yet. PR 6 registered seven v2 job types;
 * PRs 13/18/21 landed real handlers for all but `memory_v2_consolidate`, so
 * this test now only covers that one — the others have dedicated handler
 * tests in their respective modules.
 *
 * The contract being verified: while the consolidation handler is still a
 * stub (PR 20), the worker must accept the job type, log a warning, and
 * complete the row instead of failing or retrying forever.
 *
 * Uses the real SQLite test DB and `enqueueMemoryJob` so the test
 * exercises the same claim → dispatch → complete path the production
 * worker takes. The job-store mock layer is intentionally avoided so
 * future regressions in `claimMemoryJobs` filtering would also surface.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Memory enabled, cleanup off — keeps the worker focused on the
// jobs we enqueue in each test instead of also enqueuing scheduled
// pruning work.
const TEST_CONFIG = {
  memory: {
    enabled: true,
    jobs: {
      batchSize: 50,
      workerConcurrency: 4,
      stalledJobTimeoutMs: 600_000,
    },
    cleanup: { enabled: false },
  },
};

mock.module("../../config/loader.js", () => ({
  getConfig: () => TEST_CONFIG,
  loadConfig: () => TEST_CONFIG,
  invalidateConfigCache: () => {},
}));

mock.module("../db-maintenance.js", () => ({
  maybeRunDbMaintenance: () => {},
}));

// Returning a future-ish "now" stops the maintenance scheduler from
// enqueuing decay/consolidate/etc. during the test.
mock.module("../checkpoints.js", () => ({
  getMemoryCheckpoint: () => String(Date.now()),
  setMemoryCheckpoint: () => {},
}));

import { eq, inArray } from "drizzle-orm";

import { getDb, initializeDb } from "../db.js";
import { enqueueMemoryJob, type MemoryJobType } from "../jobs-store.js";
import { startMemoryJobsWorker } from "../jobs-worker.js";
import { memoryJobs } from "../schema.js";

const V2_STUB_JOB_TYPES: readonly MemoryJobType[] = [
  "memory_v2_consolidate",
] as const;

initializeDb();

async function drainJobs(): Promise<void> {
  // `startMemoryJobsWorker` kicks off an auto-tick that races with our
  // explicit `runOnce`. The auto-tick can claim a subset of pending jobs
  // first and then still be in-flight when `runOnce` returns 0; if we exit
  // immediately we may observe a job that's still in `running` state. Loop
  // until both `runOnce` AND the DB show no remaining pending/running rows
  // so either drain path finishes the queue.
  const worker = startMemoryJobsWorker();
  try {
    let safety = 20;
    while (safety > 0) {
      const processed = await worker.runOnce();
      const remaining = getDb()
        .select({ id: memoryJobs.id })
        .from(memoryJobs)
        .where(inArray(memoryJobs.status, ["pending", "running"]))
        .all().length;
      if (processed === 0 && remaining === 0) break;
      // Yield so any concurrently in-flight auto-tick can advance.
      await new Promise((resolve) => setImmediate(resolve));
      safety -= 1;
    }
  } finally {
    worker.stop();
  }
}

function getJobRow(id: string) {
  return getDb().select().from(memoryJobs).where(eq(memoryJobs.id, id)).get();
}

describe("memory v2 job-type stubs", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM memory_jobs");
  });

  for (const type of V2_STUB_JOB_TYPES) {
    test(`completes ${type} without throwing`, async () => {
      const id = enqueueMemoryJob(type, {});

      await drainJobs();

      // Stub case must complete the job (not fail or defer) so the row
      // leaves the pending queue cleanly while the real handler is being
      // built out in later PRs.
      const row = getJobRow(id);
      expect(row?.status).toBe("completed");
      expect(row?.lastError).toBeNull();
    });
  }
});
