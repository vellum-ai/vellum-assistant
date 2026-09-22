/**
 * The worker replaces a lost skill-update receipt tick on every poll,
 * whether the poll claimed jobs or found the queue empty: a receipt that is
 * open or sealed with no tick pending gets one. Runs the real worker loop
 * against the test workspace's memory database.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { setConfig } from "../../../../__tests__/helpers/set-config.js";
import { getMemoryDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { enqueueMemoryJob } from "../../../../persistence/jobs-store.js";
import { memoryJobs } from "../../../../persistence/schema/index.js";
import { registerJobHandler, runMemoryJobsOnce } from "../jobs-worker.js";
import {
  clearAllSkillUpdateReceipts,
  recordSkillUpdate,
} from "../skill-update-receipt-store.js";

setConfig("memory", { enabled: true });
await initializeDb();

registerJobHandler("index_message_lexical", async () => {});
// The tick itself is not under test; a no-op handler keeps the loop from
// running the real one against this fixture.
registerJobHandler("skill_update_receipt_tick", async () => {});

function tickStatuses(): string[] {
  return getMemoryDb()!
    .select({ status: memoryJobs.status })
    .from(memoryJobs)
    .where(eq(memoryJobs.type, "skill_update_receipt_tick"))
    .all()
    .map((row) => row.status);
}

describe("skill-update receipt tick backstop", () => {
  beforeEach(() => {
    getMemoryDb()!.delete(memoryJobs).run();
    clearAllSkillUpdateReceipts();
  });

  test("an unsettled receipt with no tick gets one on an empty poll", async () => {
    recordSkillUpdate({
      entryId: "run-1:call-1",
      skillId: "skill-a",
      name: "Skill A",
      changeSummary: "Changed a step.",
      runConversationId: "run-1",
    });

    await runMemoryJobsOnce();

    expect(tickStatuses()).toEqual(["pending"]);
  });

  test("an unsettled receipt with no tick gets one on a busy poll too", async () => {
    // A queue that never empties must not strand a receipt whose tick
    // dead-lettered: the backstop runs after a batch as well.
    recordSkillUpdate({
      entryId: "run-1:call-1",
      skillId: "skill-a",
      name: "Skill A",
      changeSummary: "Changed a step.",
      runConversationId: "run-1",
    });
    enqueueMemoryJob("index_message_lexical", { messageId: "msg-1" });

    const ran = await runMemoryJobsOnce();

    expect(ran).toBe(1);
    expect(tickStatuses()).toEqual(["pending"]);
  });

  test("no receipt, no tick", async () => {
    enqueueMemoryJob("index_message_lexical", { messageId: "msg-1" });

    await runMemoryJobsOnce();

    expect(tickStatuses()).toEqual([]);
  });
});
