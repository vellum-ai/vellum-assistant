import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

const mockWakeAgentForOpportunity = mock(() =>
  Promise.resolve({ invoked: true, producedToolCalls: false }),
);
mock.module("../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: mockWakeAgentForOpportunity,
}));

const mockEmitFeedEvent = mock(() => Promise.resolve());
mock.module("../home/emit-feed-event.js", () => ({
  emitFeedEvent: mockEmitFeedEvent,
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createSchedule } from "../schedule/schedule-store.js";
import { startScheduler } from "../schedule/scheduler.js";

initializeDb();

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

// Replace setTimeout with a fast-forward version so the scheduler
// wait calls fire quickly instead of waiting real time.
let origSetTimeout: typeof globalThis.setTimeout;

describe("scheduler wake mode", () => {
  beforeAll(() => {
    origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((
      fn: TimerHandler,
      _ms?: number,
      ...args: unknown[]
    ) => {
      return origSetTimeout(fn, 200, ...args);
    }) as typeof setTimeout;
  });

  afterAll(() => {
    globalThis.setTimeout = origSetTimeout;
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
    db.run("DELETE FROM task_runs");
    db.run("DELETE FROM tasks");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    mockWakeAgentForOpportunity.mockClear();
    mockEmitFeedEvent.mockClear();
  });

  test("wake schedule calls wakeAgentForOpportunity with correct args", async () => {
    // GIVEN a one-shot wake schedule with a conversation ID
    const schedule = createSchedule({
      name: "Wake Test",
      message: "Check back on this",
      mode: "wake",
      wakeConversationId: "conv-xyz",
      nextRunAt: Date.now() - 1000,
    });
    forceScheduleDue(schedule.id);

    const processMessage = mock(() => Promise.resolve());

    // WHEN the scheduler fires
    const scheduler = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    // THEN wakeAgentForOpportunity is called with the correct arguments
    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);
    expect(mockWakeAgentForOpportunity).toHaveBeenCalledWith({
      conversationId: "conv-xyz",
      hint: "Check back on this",
      source: "defer",
    });

    // AND processMessage is never called (wake mode doesn't use it)
    expect(processMessage).not.toHaveBeenCalled();
  });

  test("missing wakeConversationId logs warning and completes (not fails)", async () => {
    // GIVEN a one-shot wake schedule WITHOUT a conversation ID
    // We need to create it with a wakeConversationId first (validation requires it),
    // then clear it at the DB level to simulate a missing value at runtime.
    const schedule = createSchedule({
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

    const processMessage = mock(() => Promise.resolve());

    // WHEN the scheduler fires
    const scheduler = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

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

    const schedule = createSchedule({
      name: "Wake Complete",
      message: "Should complete",
      mode: "wake",
      wakeConversationId: "conv-abc",
      nextRunAt: Date.now() - 1000,
    });
    forceScheduleDue(schedule.id);

    // WHEN the scheduler fires
    const scheduler = startScheduler(
      mock(() => Promise.resolve()),
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    // THEN the one-shot is marked as completed (status = 'fired')
    const row = getRawDb()
      .query("SELECT status FROM cron_jobs WHERE id = ?")
      .get(schedule.id) as { status: string } | null;
    expect(row?.status).toBe("fired");
  });

  test("failed wake marks one-shot as failed", async () => {
    // GIVEN a one-shot wake schedule where wakeAgentForOpportunity throws
    mockWakeAgentForOpportunity.mockRejectedValueOnce(new Error("Wake failed"));

    const schedule = createSchedule({
      name: "Wake Fail",
      message: "Should fail",
      mode: "wake",
      wakeConversationId: "conv-fail",
      nextRunAt: Date.now() - 1000,
    });
    forceScheduleDue(schedule.id);

    // WHEN the scheduler fires
    const scheduler = startScheduler(
      mock(() => Promise.resolve()),
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    // THEN the one-shot is reverted to 'active' for retry (failOneShot behavior)
    const row = getRawDb()
      .query("SELECT status FROM cron_jobs WHERE id = ?")
      .get(schedule.id) as { status: string } | null;
    expect(row?.status).toBe("active");
  });

  test("quiet: true suppresses feed event", async () => {
    // GIVEN a one-shot wake schedule with quiet: true
    const schedule = createSchedule({
      name: "Wake Quiet",
      message: "Quiet wake",
      mode: "wake",
      wakeConversationId: "conv-quiet",
      quiet: true,
      nextRunAt: Date.now() - 1000,
    });
    forceScheduleDue(schedule.id);

    // WHEN the scheduler fires
    const scheduler = startScheduler(
      mock(() => Promise.resolve()),
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    // THEN wakeAgentForOpportunity is called
    expect(mockWakeAgentForOpportunity).toHaveBeenCalledTimes(1);

    // AND no feed event is emitted
    expect(mockEmitFeedEvent).not.toHaveBeenCalled();
  });

  test("quiet: false emits feed event on success", async () => {
    // GIVEN a one-shot wake schedule with quiet: false (default)
    const schedule = createSchedule({
      name: "Wake Loud",
      message: "Loud wake",
      mode: "wake",
      wakeConversationId: "conv-loud",
      nextRunAt: Date.now() - 1000,
    });
    forceScheduleDue(schedule.id);

    // WHEN the scheduler fires
    const scheduler = startScheduler(
      mock(() => Promise.resolve()),
      () => {},
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    // THEN a feed event IS emitted
    expect(mockEmitFeedEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitFeedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "assistant",
        title: "Wake Loud",
        summary: "Deferred wake fired.",
      }),
    );
  });
});
