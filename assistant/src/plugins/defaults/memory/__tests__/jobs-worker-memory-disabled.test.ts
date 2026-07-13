/**
 * With `memory.enabled === false` the job worker still drains the
 * MESSAGE-LEXICAL job types (host-owned message-search indexing that shares
 * the queue) while every memory job stays pending — the slow and embed lanes
 * get no budget and the fast lane is restricted to the lexical types.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { setConfig } from "../../../../__tests__/helpers/set-config.js";

// Seed only `memory.enabled`; the schema fills the rest of the memory block
// (including `v2.enabled`, default true) with its defaults, matching the
// full-default config these tests ran under.
function seedMemoryEnabled(enabled: boolean): void {
  setConfig("memory", { enabled });
}

import { getMemoryDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { enqueueMemoryJob } from "../../../../persistence/jobs-store.js";
import { memoryJobs } from "../../../../persistence/schema/index.js";
import { registerJobHandler, runMemoryJobsOnce } from "../jobs-worker.js";

seedMemoryEnabled(false);
await initializeDb();

const processed: string[] = [];
registerJobHandler("index_message_lexical", async (job) => {
  processed.push(job.type);
});
registerJobHandler("memory_v2_activation_recompute", async (job) => {
  processed.push(job.type);
});

function jobStatuses(type: string): string[] {
  return getMemoryDb()!
    .select({ status: memoryJobs.status })
    .from(memoryJobs)
    .where(eq(memoryJobs.type, type))
    .all()
    .map((row) => row.status);
}

describe("runMemoryJobsOnce with memory disabled", () => {
  beforeEach(() => {
    getMemoryDb()!.delete(memoryJobs).run();
    processed.length = 0;
    seedMemoryEnabled(false);
  });

  test("drains lexical jobs while leaving memory jobs pending", async () => {
    enqueueMemoryJob("index_message_lexical", { messageId: "msg-1" });
    // A fast-lane MEMORY job type: proves the restriction is by type, not
    // just by zeroing the slow/embed lane budgets.
    enqueueMemoryJob("memory_v2_activation_recompute", {});

    const ran = await runMemoryJobsOnce();

    expect(ran).toBe(1);
    expect(processed).toEqual(["index_message_lexical"]);
    expect(jobStatuses("index_message_lexical")).toEqual(["completed"]);
    expect(jobStatuses("memory_v2_activation_recompute")).toEqual(["pending"]);
  });

  test("drains both once memory is re-enabled", async () => {
    enqueueMemoryJob("index_message_lexical", { messageId: "msg-2" });
    enqueueMemoryJob("memory_v2_activation_recompute", {});

    seedMemoryEnabled(true);
    const ran = await runMemoryJobsOnce();

    expect(ran).toBe(2);
    expect(jobStatuses("index_message_lexical")).toEqual(["completed"]);
    expect(jobStatuses("memory_v2_activation_recompute")).toEqual([
      "completed",
    ]);
  });
});
