/**
 * Regression: the one-shot `sweep_orphaned_graph_node_points` cleanup
 * (migration 341) must NOT be completed as a no-op when `memory.v2.enabled` is
 * true. It has no re-enqueue, so completing it under v2 would permanently lose
 * the cleanup — startup leaves the v1 collection on disk, so a later v2→v1
 * rollback still needs the sweep to run against the cacheless orphan points.
 * Instead the worker holds the job pending (future `run_after`, no attempt or
 * deferral spent) so it survives an arbitrarily long v2 window and runs once v1
 * is active again.
 *
 * The other `V1_QDRANT_JOB_TYPES` keep their no-op completion under v2 — their
 * live write paths re-enqueue them, so draining stale backlog rows is correct.
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

// `memory.enabled` and `memory.v2.enabled` both default true, so the real
// loader reading this file's (empty) workspace config already yields the
// v2-enabled state this regression needs — no seeding required.

mock.module("../graph/graph-search.js", () => ({
  searchGraphNodes: async () => [],
  embedGraphNodeDirect: async () => {},
  embedGraphNodeJob: async (): Promise<void> => {},
  enqueueGraphNodeEmbed: () => {},
  embedGraphTriggerJob: async (): Promise<void> => {},
  enqueueGraphTriggerEmbed: () => {},
}));

mock.module("../../../../persistence/db-maintenance.js", () => ({
  maybeRunDbMaintenance: async () => {},
  maybeRunPassiveWalCheckpoint: async () => {},
}));

const tmpWorkspace = mkdtempSync(join(tmpdir(), "jobs-worker-v2-sweep-defer-"));
const previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

import { getMemoryDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { _resetQdrantBreaker } from "../../../../persistence/embeddings/qdrant-circuit-breaker.js";
import { enqueueMemoryJob } from "../../../../persistence/jobs-store.js";
import { memoryJobs } from "../../../../persistence/schema/index.js";
import { registerMemoryPluginJobHandlers } from "../job-handler-registration.js";
import { runMemoryJobsOnce } from "../jobs-worker.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

function jobRow(jobId: string) {
  return getMemoryDb()!
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.id, jobId))
    .get();
}

describe("V1 Qdrant job dispatch under memory v2", () => {
  beforeAll(async () => {
    registerMemoryPluginJobHandlers();
    await initializeDb();
  });

  afterAll(() => {
    if (previousWorkspaceEnv === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
    }
    rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    getMemoryDb()!.run("DELETE FROM memory_jobs");
    _resetQdrantBreaker();
  });

  test("holds the cacheless graph-node sweep pending, spending no attempt or deferral", async () => {
    const jobId = enqueueMemoryJob("sweep_orphaned_graph_node_points", {});

    await runMemoryJobsOnce();

    const row = jobRow(jobId);
    expect(row?.status).toBe("pending");
    // Rescheduled a generous window out — not a hot loop, and not dead-lettered.
    expect(row!.runAfter).toBeGreaterThan(Date.now() + ONE_HOUR_MS);
    // The postpone must not burn the retry/deferral budgets that would
    // eventually fail the job if v2 stays enabled for months.
    expect(row!.attempts).toBe(0);
    expect(row!.deferrals).toBe(0);
  });

  test("still completes other v1 Qdrant job types as a no-op", async () => {
    const jobId = enqueueMemoryJob("delete_qdrant_vectors", {
      targetType: "graph_node",
      targetId: "node-1",
    });

    await runMemoryJobsOnce();

    expect(jobRow(jobId)?.status).toBe("completed");
  });
});
