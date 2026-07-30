import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockWakeAgentForOpportunity = mock(
  (): Promise<{
    invoked: boolean;
    producedToolCalls: boolean;
    reason?: string;
  }> => Promise.resolve({ invoked: true, producedToolCalls: false }),
);
mock.module("../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: mockWakeAgentForOpportunity,
}));

const mockProcessMessage = mock((..._args: unknown[]) => Promise.resolve());
mock.module("../daemon/process-message.js", () => ({
  processMessage: mockProcessMessage,
}));

import { INTERNAL_GUARDIAN_TRUST_CONTEXT } from "../daemon/trust-context.js";
import {
  createConversation,
  setConversationOriginChannelIfUnset,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  createOwnerDeferredWake,
  createSchedule,
} from "../schedule/schedule-store.js";
import { runDueSchedulesOnce } from "../schedule/scheduler.js";

await initializeDb();

/** Access the underlying bun:sqlite Database for raw parameterized queries. */
function getRawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

/** Force a schedule to be due by setting next_run_at in the past. */
function forceScheduleDue(scheduleId: string): void {
  getRawDb().run("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?", [
    Date.now() - 1000,
    scheduleId,
  ]);
}

describe("scheduler wake mode", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
    db.run("DELETE FROM task_runs");
    db.run("DELETE FROM tasks");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    mockWakeAgentForOpportunity.mockClear();
    mockProcessMessage.mockClear();
  });

  test("wake schedule calls wakeAgentForOpportunity with correct args", async () => {
    // GIVEN a one-shot wake schedule targeting a local conversation
    createConversation({ id: "conv-xyz" });
    const schedule = await createOwnerDeferredWake({
      conversationId: "conv-xyz",
      hint: "Check back on this",
      fireAt: Date.now() - 1000,
      name: "Wake Test",
    });
    forceScheduleDue(schedule.id);

    // WHEN the scheduler fires
    await runDueSchedulesOnce();

    // THEN wakeAgentForOpportunity is called with the correct arguments,
    // including the target conversation's guardian resting trust, which the
    // resumed turn runs under.
    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);
    expect(mockWakeAgentForOpportunity).toHaveBeenCalledWith({
      conversationId: "conv-xyz",
      hint: "Check back on this",
      source: "defer",
      persistTriggerAsEvent: true,
      trustContext: INTERNAL_GUARDIAN_TRUST_CONTEXT,
    });

    // AND processMessage is never called (wake mode doesn't use it)
    expect(mockProcessMessage).not.toHaveBeenCalled();
  });

  test("a wake on a remote-channel conversation carries no elevated trust", async () => {
    // GIVEN a wake schedule whose target conversation originated on a remote
    // channel, so no resting trust can be reconstructed for it
    createConversation({ id: "conv-telegram" });
    setConversationOriginChannelIfUnset("conv-telegram", "telegram");
    const schedule = await createSchedule({
      name: "Remote Wake",
      message: "Follow up",
      mode: "wake",
      wakeConversationId: "conv-telegram",
      nextRunAt: Date.now() - 1000,
    });
    forceScheduleDue(schedule.id);

    // WHEN the scheduler fires
    await runDueSchedulesOnce();

    // THEN the wake runs with no trust context at all, so the turn resolves the
    // fail-closed `unknown` class and sensitive tools stay denied
    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);
    expect(mockWakeAgentForOpportunity).toHaveBeenCalledWith({
      conversationId: "conv-telegram",
      hint: "Follow up",
      source: "defer",
      persistTriggerAsEvent: true,
    });
  });

  test("missing wakeConversationId logs warning and completes (not fails)", async () => {
    // GIVEN a one-shot wake schedule WITHOUT a conversation ID
    // We need to create it with a wakeConversationId first (validation requires it),
    // then clear it at the DB level to simulate a missing value at runtime.
    const schedule = await createSchedule({
      name: "Wake No Conv",
      message: "Missing conv",
      mode: "wake",
      wakeConversationId: "conv-placeholder",
      nextRunAt: Date.now() - 1000,
    });
    getRawDb().run(
      "UPDATE cron_jobs SET wake_conversation_id = NULL WHERE id = ?",
      [schedule.id],
    );
    forceScheduleDue(schedule.id);

    // WHEN the scheduler fires
    await runDueSchedulesOnce();

    // THEN wakeAgentForOpportunity is NOT called
    expect(mockWakeAgentForOpportunity).not.toHaveBeenCalled();

    // AND the one-shot is completed (not failed) — check status is 'fired' not 'cancelled'
    const row = getRawDb()
      .query("SELECT status FROM cron_jobs WHERE id = ?")
      .get(schedule.id) as { status: string } | null;
    expect(row?.status).toBe("fired");
  });

  test("successful wake marks one-shot as completed", async () => {
    // GIVEN a one-shot wake schedule
    mockWakeAgentForOpportunity.mockResolvedValueOnce({
      invoked: true,
      producedToolCalls: false,
    });

    const schedule = await createSchedule({
      name: "Wake Complete",
      message: "Should complete",
      mode: "wake",
      wakeConversationId: "conv-abc",
      nextRunAt: Date.now() - 1000,
    });
    forceScheduleDue(schedule.id);

    // WHEN the scheduler fires
    await runDueSchedulesOnce();

    // THEN the one-shot is marked as completed (status = 'fired')
    const row = getRawDb()
      .query("SELECT status FROM cron_jobs WHERE id = ?")
      .get(schedule.id) as { status: string } | null;
    expect(row?.status).toBe("fired");
  });

  test("failed wake marks one-shot as failed", async () => {
    // GIVEN a one-shot wake schedule where wakeAgentForOpportunity throws
    mockWakeAgentForOpportunity.mockRejectedValueOnce(new Error("Wake failed"));

    const schedule = await createSchedule({
      name: "Wake Fail",
      message: "Should fail",
      mode: "wake",
      wakeConversationId: "conv-fail",
      nextRunAt: Date.now() - 1000,
    });
    forceScheduleDue(schedule.id);

    // WHEN the scheduler fires
    await runDueSchedulesOnce();

    // THEN the one-shot is reverted to 'active' for retry (failOneShot behavior)
    const row = getRawDb()
      .query("SELECT status FROM cron_jobs WHERE id = ?")
      .get(schedule.id) as { status: string } | null;
    expect(row?.status).toBe("active");
  });

  test("retries wake when wakeAgentForOpportunity returns timeout", async () => {
    // GIVEN wakeAgentForOpportunity returns timeout on first call, then succeeds
    mockWakeAgentForOpportunity
      .mockResolvedValueOnce({
        invoked: false,
        producedToolCalls: false,
        reason: "timeout",
      })
      .mockResolvedValueOnce({
        invoked: true,
        producedToolCalls: false,
      });

    const schedule = await createSchedule({
      name: "Wake Retry",
      message: "Retry after timeout",
      mode: "wake",
      wakeConversationId: "conv-retry",
      nextRunAt: Date.now() - 1000,
    });
    forceScheduleDue(schedule.id);

    // WHEN the first tick runs
    await runDueSchedulesOnce();

    // THEN the job is NOT completed — it's reverted to 'active' for retry
    const rowAfterFirst = getRawDb()
      .query("SELECT status, retry_count FROM cron_jobs WHERE id = ?")
      .get(schedule.id) as { status: string; retry_count: number } | null;
    expect(rowAfterFirst?.status).toBe("active");
    expect(rowAfterFirst?.retry_count).toBe(1);

    // WHEN the second tick fires
    await runDueSchedulesOnce();

    // THEN the job IS completed (status = 'fired')
    const rowAfterSecond = getRawDb()
      .query("SELECT status FROM cron_jobs WHERE id = ?")
      .get(schedule.id) as { status: string } | null;
    expect(rowAfterSecond?.status).toBe("fired");

    // AND wakeAgentForOpportunity was called twice total
    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(2);
  });

  test("fails wake after max retries on persistent timeout", async () => {
    // GIVEN wakeAgentForOpportunity always returns timeout
    mockWakeAgentForOpportunity.mockResolvedValue({
      invoked: false,
      producedToolCalls: false,
      reason: "timeout",
    });

    const schedule = await createSchedule({
      name: "Wake Max Retry",
      message: "Always busy",
      mode: "wake",
      wakeConversationId: "conv-busy",
      nextRunAt: Date.now() - 1000,
    });
    forceScheduleDue(schedule.id);

    // Simulate having already retried up to the max (set retry_count = 20)
    getRawDb().run("UPDATE cron_jobs SET retry_count = 20 WHERE id = ?", [
      schedule.id,
    ]);

    // WHEN the scheduler fires
    await runDueSchedulesOnce();

    // THEN the job is permanently failed (status = 'cancelled', enabled = false)
    const row = getRawDb()
      .query("SELECT status, enabled FROM cron_jobs WHERE id = ?")
      .get(schedule.id) as { status: string; enabled: number } | null;
    expect(row?.status).toBe("cancelled");
    expect(row?.enabled).toBe(0);
  });
});
