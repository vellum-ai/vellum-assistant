/**
 * The memory queue's drain gate lives in `claimMemoryJobs` — while a quiesce
 * lease is active the queue claims nothing, and, critically, an absent or
 * expired lease must leave claiming fully open (an inverted or stuck gate
 * would silently stop retrospectives and consolidation for every install).
 * The gate sits in the persistence claim path rather than the worker loop so
 * the plugin needs no import from outside its own directory.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import { createMockLoggerModule } from "../../../../__tests__/helpers/mock-logger.js";

mock.module("../../../../util/logger.js", () => createMockLoggerModule());

import { setMemoryCheckpoint } from "../../../../persistence/checkpoints.js";
import { getMemoryDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import {
  claimMemoryJobs,
  enqueueMemoryJob,
} from "../../../../persistence/jobs-store.js";
import {
  clearLifecycleQuiesce,
  setLifecycleQuiesce,
} from "../../../../persistence/lifecycle-quiesce.js";
import { resetTestTables } from "../../../../persistence/raw-query.js";
import { memoryJobs } from "../../../../persistence/schema/index.js";
import { runMemoryJobsOnce } from "../jobs-worker.js";

const QUIESCE_KEY = "lifecycle:quiesce_until";
const ALL_LANES = { slowLlm: 1, fast: 1, embed: 1 };

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

describe("memory job claim quiesce gate", () => {
  test("active lease: claimMemoryJobs claims nothing", () => {
    const jobId = enqueueMemoryJob("index_message_lexical", {});
    setLifecycleQuiesce(60_000);

    const claimed = claimMemoryJobs(ALL_LANES);

    expect(claimed).toHaveLength(0);
    expect(jobStatus(jobId)).toBe("pending");
  });

  test("no lease: claiming is fully open (fail-open default)", () => {
    const jobId = enqueueMemoryJob("index_message_lexical", {});

    const claimed = claimMemoryJobs(ALL_LANES);

    expect(claimed).toHaveLength(1);
    expect(jobStatus(jobId)).toBe("running");
  });

  test("expired lease: claiming is open again (TTL fail-open)", () => {
    setMemoryCheckpoint(QUIESCE_KEY, String(Date.now() - 1));
    const jobId = enqueueMemoryJob("index_message_lexical", {});

    const claimed = claimMemoryJobs(ALL_LANES);

    expect(claimed).toHaveLength(1);
    expect(jobStatus(jobId)).toBe("running");
  });

  test("worker tick under an active lease leaves the queue untouched", async () => {
    const jobId = enqueueMemoryJob("index_message_lexical", {});
    setLifecycleQuiesce(60_000);

    const processed = await runMemoryJobsOnce();

    expect(processed).toBe(0);
    expect(jobStatus(jobId)).toBe("pending");
  });
});
