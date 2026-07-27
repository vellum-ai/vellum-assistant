/**
 * The memory jobs worker's drain gate: while a quiesce lease is active,
 * `runMemoryJobsOnce` must claim nothing and enqueue no maintenance — and,
 * critically, an absent or expired lease must leave the worker fully open
 * (an inverted or stuck gate would silently stop retrospectives and
 * consolidation for every user).
 *
 * "Gate open" is probed through the sweep-checkpoint seed: an empty-queue
 * tick seeds `RETROSPECTIVE_SWEEP_CHECKPOINT` on its maintenance path, so
 * the checkpoint's presence proves the tick got past the gate.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import { createMockLoggerModule } from "../../../../__tests__/helpers/mock-logger.js";

mock.module("../../../../util/logger.js", () => createMockLoggerModule());

import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../../../../persistence/checkpoints.js";
import { getMemoryDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { enqueueMemoryJob } from "../../../../persistence/jobs-store.js";
import {
  clearLifecycleQuiesce,
  setLifecycleQuiesce,
} from "../../../../persistence/lifecycle-quiesce.js";
import { resetTestTables } from "../../../../persistence/raw-query.js";
import { memoryJobs } from "../../../../persistence/schema/index.js";
import {
  RETROSPECTIVE_SWEEP_CHECKPOINT,
  runMemoryJobsOnce,
} from "../jobs-worker.js";

const QUIESCE_KEY = "lifecycle:quiesce_until";

await initializeDb();
getMemoryDb();

function jobStatus(id: string): string | undefined {
  return getMemoryDb()!
    .select({ status: memoryJobs.status })
    .from(memoryJobs)
    .where(eq(memoryJobs.id, id))
    .get()?.status;
}

beforeEach(() => {
  getMemoryDb()!.run("DELETE FROM memory_jobs");
  resetTestTables("memory_checkpoints");
  clearLifecycleQuiesce();
});

describe("memory jobs worker quiesce gate", () => {
  test("active lease: claims nothing and runs no maintenance", async () => {
    const jobId = enqueueMemoryJob("memory_v2_consolidate", {});
    setLifecycleQuiesce(60_000);

    const processed = await runMemoryJobsOnce();

    expect(processed).toBe(0);
    expect(jobStatus(jobId)).toBe("pending");
    // Maintenance never ran, so the sweep checkpoint was not seeded.
    expect(getMemoryCheckpoint(RETROSPECTIVE_SWEEP_CHECKPOINT)).toBeNull();
  });

  test("no lease: the tick reaches the maintenance path (gate open)", async () => {
    await runMemoryJobsOnce();

    expect(getMemoryCheckpoint(RETROSPECTIVE_SWEEP_CHECKPOINT)).not.toBeNull();
  });

  test("expired lease: the gate is open again (TTL fail-open)", async () => {
    setMemoryCheckpoint(QUIESCE_KEY, String(Date.now() - 1));

    await runMemoryJobsOnce();

    expect(getMemoryCheckpoint(RETROSPECTIVE_SWEEP_CHECKPOINT)).not.toBeNull();
  });
});
