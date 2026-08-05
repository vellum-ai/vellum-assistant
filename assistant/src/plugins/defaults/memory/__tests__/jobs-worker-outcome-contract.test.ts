/**
 * Outcome-truthfulness contract between job handlers and the jobs worker.
 *
 * Handlers that report failure through a RETURNED domain outcome (the
 * retrospective's `wake_failed` / `no_usable_output` / `source_processing`,
 * the consolidation's `run_failed`) must not leave their job rows reading
 * `completed` with a null `last_error`. The registration-site adapters in
 * `job-handlers.ts` translate domain outcomes into `JobQueueResolution`s and
 * the worker applies them, so the persisted `memory_jobs.status` reflects the
 * handler's actual outcome.
 *
 * Also covers the store-level late-transition guards: once the stalled-job
 * watchdog fails a row, a late `completeMemoryJob` from the abandoned
 * execution must not flip it back to `completed`.
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

import type { MemoryRetrospectiveOutcome } from "../memory-retrospective-job.js";
import type { ConsolidationOutcome } from "../substrate/consolidation-job.js";

// Scripted handler outcomes, set per-test.
let retrospectiveOutcome: MemoryRetrospectiveOutcome = {
  kind: "no_new_messages",
};
let consolidationOutcome: ConsolidationOutcome = { kind: "empty_buffer" };

mock.module("../memory-retrospective-job.js", () => ({
  memoryRetrospectiveJob: async () => retrospectiveOutcome,
  STALE_SOURCE_PROCESSING_OVERRIDE_MS: 6 * 60 * 60 * 1000,
}));

mock.module("../substrate/consolidation-job.js", () => ({
  memoryV2ConsolidateJob: async () => consolidationOutcome,
  // Scheduler helpers the worker reads on every pass.
  countBufferLines: () => 0,
  readConsolidationFailureState: () => null,
}));

mock.module("../graph/graph-search.js", () => ({
  embedGraphNodeDirect: async () => {},
  embedGraphNodeJob: async (): Promise<void> => {},
  enqueueGraphNodeEmbed: () => {},
  embedGraphTriggerJob: async (): Promise<void> => {},
  enqueueGraphTriggerEmbed: () => {},
}));

mock.module("../v1/graph/graph-search.js", () => ({
  searchGraphNodes: async () => [],
}));

mock.module("../../../../persistence/db-maintenance.js", () => ({
  maybeRunDbMaintenance: async () => {},
  maybeRunPassiveWalCheckpoint: async () => {},
}));

const tmpWorkspace = mkdtempSync(
  join(tmpdir(), "jobs-worker-outcome-contract-"),
);
const previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

import { getMemoryDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { _resetQdrantBreaker } from "../../../../persistence/embeddings/qdrant-circuit-breaker.js";
import {
  completeMemoryJob,
  enqueueMemoryJob,
  failStalledJobs,
} from "../../../../persistence/jobs-store.js";
import { memoryJobs } from "../../../../persistence/schema/index.js";
import { registerMemoryPluginJobHandlers } from "../job-handler-registration.js";
import { runMemoryJobsOnce } from "../jobs-worker.js";

function jobRow(jobId: string) {
  return getMemoryDb()!
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.id, jobId))
    .get();
}

describe("job outcome truthfulness", () => {
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
    retrospectiveOutcome = { kind: "no_new_messages" };
    consolidationOutcome = { kind: "empty_buffer" };
  });

  test("retrospective wake_failed dead-letters the row with an honest last_error", async () => {
    retrospectiveOutcome = { kind: "wake_failed", reason: "run_error" };
    const jobId = enqueueMemoryJob("memory_retrospective", {
      conversationId: "conv-1",
    });

    await runMemoryJobsOnce();

    const row = jobRow(jobId);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("retrospective wake failed");
    expect(row?.lastError).toContain("run_error");
  });

  test("retrospective no_usable_output dead-letters the row with the failure detail", async () => {
    retrospectiveOutcome = {
      kind: "no_usable_output",
      reason: "run persisted no memory-writing tool call",
    };
    const jobId = enqueueMemoryJob("memory_retrospective", {
      conversationId: "conv-1",
    });

    await runMemoryJobsOnce();

    const row = jobRow(jobId);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("no usable output");
  });

  test("retrospective source_processing defers the SAME row on the deferral counter", async () => {
    retrospectiveOutcome = { kind: "source_processing" };
    const jobId = enqueueMemoryJob("memory_retrospective", {
      conversationId: "conv-1",
    });

    const before = Date.now();
    await runMemoryJobsOnce();

    const row = jobRow(jobId);
    expect(row?.status).toBe("pending");
    expect(row?.deferrals).toBe(1);
    expect(row?.attempts).toBe(0);
    expect(row!.runAfter).toBeGreaterThan(before);
    // Exactly one row for the conversation: no fresh row minted per attempt.
    const rows = getMemoryDb()!
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "memory_retrospective"))
      .all();
    expect(rows).toHaveLength(1);
  });

  test("source_processing deferral budget exhausts into an honest terminal failure", async () => {
    retrospectiveOutcome = { kind: "source_processing" };
    const jobId = enqueueMemoryJob("memory_retrospective", {
      conversationId: "conv-1",
    });
    // Spend 49 of the 50 deferrals up front; the next pass is the last one.
    getMemoryDb()!
      .update(memoryJobs)
      .set({ deferrals: 49 })
      .where(eq(memoryJobs.id, jobId))
      .run();

    await runMemoryJobsOnce();

    const row = jobRow(jobId);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("mid-turn");
  });

  test("retrospective success and benign no-ops still complete", async () => {
    retrospectiveOutcome = { kind: "no_new_messages" };
    const jobId = enqueueMemoryJob("memory_retrospective", {
      conversationId: "conv-1",
    });

    await runMemoryJobsOnce();

    expect(jobRow(jobId)?.status).toBe("completed");
  });

  test("consolidation run_failed dead-letters the row with the failure reason", async () => {
    consolidationOutcome = { kind: "run_failed", reason: "timeout" };
    const jobId = enqueueMemoryJob("memory_v2_consolidate", {});

    await runMemoryJobsOnce();

    const row = jobRow(jobId);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("consolidation run failed");
    expect(row?.lastError).toContain("timeout");
  });

  test("consolidation skips (locked/empty) still complete", async () => {
    consolidationOutcome = { kind: "locked", holder: "1234 0 consolidation" };
    const jobId = enqueueMemoryJob("memory_v2_consolidate", {});

    await runMemoryJobsOnce();

    expect(jobRow(jobId)?.status).toBe("completed");
  });

  test("late completion cannot overwrite a watchdog-failed row", async () => {
    const jobId = enqueueMemoryJob("memory_retrospective", {
      conversationId: "conv-1",
    });
    // Simulate a claimed row whose execution went silent long enough for the
    // stalled-job watchdog to fail it.
    getMemoryDb()!
      .update(memoryJobs)
      .set({ status: "running", startedAt: Date.now() - 60 * 60 * 1000 })
      .where(eq(memoryJobs.id, jobId))
      .run();
    expect(failStalledJobs(30 * 60 * 1000)).toBe(1);
    expect(jobRow(jobId)?.status).toBe("failed");

    // The abandoned execution finally returns and reports success.
    completeMemoryJob(jobId);

    const row = jobRow(jobId);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("timed out");
  });
});
