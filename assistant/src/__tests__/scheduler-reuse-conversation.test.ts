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

// Mock the shared `runBackgroundJob` runner so the scheduler's fresh-bootstrap
// talk-mode path stays observable in unit tests. Each invocation creates a new
// conversation row (so `getLastScheduleConversationId` lookups reflect reality)
// and pushes onto a shared log mirrored by the per-test `processMessage`
// callback used for the reuse path — that way assertions don't have to know
// which path a given run took.
const processedMessages: { conversationId: string; message: string }[] = [];
const runBackgroundJobOptions: Array<{
  conversationType?: string;
  scheduleJobId?: string;
  groupId?: string;
  suppressFailureNotifications?: boolean;
  onConversationCreated?: (id: string) => void;
}> = [];
let runBackgroundJobShouldFail = false;
mock.module("../runtime/background-job-runner.js", () => ({
  runBackgroundJob: async (opts: {
    prompt: string;
    groupId?: string;
    conversationType?: "background" | "scheduled";
    scheduleJobId?: string;
    suppressFailureNotifications?: boolean;
    onConversationCreated?: (id: string) => void;
  }) => {
    const { createConversation } =
      await import("../memory/conversation-crud.js");
    const conv = createConversation({
      title: "(test stub)",
      conversationType: opts.conversationType ?? "background",
      source: "schedule",
      ...(opts.groupId ? { groupId: opts.groupId } : {}),
      ...(opts.scheduleJobId ? { scheduleJobId: opts.scheduleJobId } : {}),
    });
    runBackgroundJobOptions.push({
      conversationType: opts.conversationType,
      scheduleJobId: opts.scheduleJobId,
      groupId: opts.groupId,
      suppressFailureNotifications: opts.suppressFailureNotifications,
      onConversationCreated: opts.onConversationCreated,
    });
    // Mirror the real runner's contract: fire the SSE callback synchronously
    // BEFORE the job's processMessage finishes, with the bootstrap-returned
    // conversation id.
    opts.onConversationCreated?.(conv.id);
    processedMessages.push({ conversationId: conv.id, message: opts.prompt });
    if (runBackgroundJobShouldFail) {
      return {
        conversationId: conv.id,
        ok: false,
        error: new Error("Simulated failure"),
        errorKind: "exception" as const,
      };
    }
    return { conversationId: conv.id, ok: true };
  },
}));

import { deleteConversation } from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { createSchedule, getScheduleRuns } from "../schedule/schedule-store.js";
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

// Build an RRULE expression anchored at the given start date, recurring every minute.
function buildEveryMinuteRrule(dtstart: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ds = `${dtstart.getUTCFullYear()}${pad(dtstart.getUTCMonth() + 1)}${pad(
    dtstart.getUTCDate(),
  )}T${pad(dtstart.getUTCHours())}${pad(dtstart.getUTCMinutes())}${pad(
    dtstart.getUTCSeconds(),
  )}Z`;
  return `DTSTART:${ds}\nRRULE:FREQ=MINUTELY;INTERVAL=1`;
}

// Replace setTimeout with a zero-delay version so the 500ms scheduler
// wait calls fire instantly instead of waiting real time.
let origSetTimeout: typeof globalThis.setTimeout;

describe("scheduler conversation reuse", () => {
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
    processedMessages.length = 0;
    runBackgroundJobOptions.length = 0;
    runBackgroundJobShouldFail = false;
  });

  test("recurring schedule with reuseConversation=true reuses conversation across runs", async () => {
    /**
     * When a recurring schedule has reuseConversation enabled, the second run
     * should reuse the conversation created by the first run.
     */

    // GIVEN a recurring schedule with reuseConversation enabled
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = createSchedule({
      name: "Reuse Test",
      cronExpression: rruleExpr,
      message: "Reuse conversation message",
      syntax: "rrule",
      expression: rruleExpr,
      reuseConversation: true,
    });

    // WHEN the schedule fires for the first time
    forceScheduleDue(schedule.id);

    const processMessage = async (conversationId: string, message: string) => {
      processedMessages.push({ conversationId, message });
    };

    const scheduler1 = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler1.stop();

    // THEN a conversation is created and recorded
    expect(processedMessages).toHaveLength(1);
    const firstConversationId = processedMessages[0].conversationId;
    expect(firstConversationId).toBeTruthy();

    // AND a successful run is recorded
    const runs1 = getScheduleRuns(schedule.id);
    expect(runs1.length).toBe(1);
    expect(runs1[0].status).toBe("ok");
    expect(runs1[0].conversationId).toBe(firstConversationId);

    // WHEN the schedule fires for the second time
    forceScheduleDue(schedule.id);
    processedMessages.length = 0;

    const scheduler2 = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler2.stop();

    // THEN the same conversation is reused
    expect(processedMessages).toHaveLength(1);
    expect(processedMessages[0].conversationId).toBe(firstConversationId);

    // AND the run references the reused conversation
    const runs2 = getScheduleRuns(schedule.id);
    expect(runs2.length).toBe(2);
    expect(runs2[0].conversationId).toBe(firstConversationId);
  });

  test("recurring schedule with reuseConversation=false creates new conversation each run", async () => {
    /**
     * Default behavior: each run creates a brand-new conversation.
     */

    // GIVEN a recurring schedule with reuseConversation disabled (default)
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = createSchedule({
      name: "No Reuse Test",
      cronExpression: rruleExpr,
      message: "New conv each run",
      syntax: "rrule",
      expression: rruleExpr,
      // reuseConversation defaults to false
    });

    // WHEN the schedule fires for the first time
    forceScheduleDue(schedule.id);

    const processMessage = async (conversationId: string, message: string) => {
      processedMessages.push({ conversationId, message });
    };

    const scheduler1 = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler1.stop();

    expect(processedMessages).toHaveLength(1);
    const firstConversationId = processedMessages[0].conversationId;

    // WHEN the schedule fires for the second time
    forceScheduleDue(schedule.id);
    processedMessages.length = 0;

    const scheduler2 = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler2.stop();

    // THEN a different conversation is created
    expect(processedMessages).toHaveLength(1);
    expect(processedMessages[0].conversationId).not.toBe(firstConversationId);
  });

  test("reuseConversation creates a new conversation when prior one is deleted", async () => {
    /**
     * If the conversation from the last successful run has been deleted,
     * a fresh conversation should be bootstrapped.
     */

    // GIVEN a recurring schedule with reuseConversation enabled that has already run once
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = createSchedule({
      name: "Deleted Conv Test",
      cronExpression: rruleExpr,
      message: "Handle deleted conv",
      syntax: "rrule",
      expression: rruleExpr,
      reuseConversation: true,
    });

    forceScheduleDue(schedule.id);

    const processMessage = async (conversationId: string, message: string) => {
      processedMessages.push({ conversationId, message });
    };

    const scheduler1 = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler1.stop();

    expect(processedMessages).toHaveLength(1);
    const firstConversationId = processedMessages[0].conversationId;

    // AND the conversation is deleted
    deleteConversation(firstConversationId);

    // WHEN the schedule fires again
    forceScheduleDue(schedule.id);
    processedMessages.length = 0;

    const scheduler2 = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler2.stop();

    // THEN a new conversation is created (not the deleted one)
    expect(processedMessages).toHaveLength(1);
    expect(processedMessages[0].conversationId).not.toBe(firstConversationId);
  });

  test("one-shot schedule ignores reuseConversation flag", async () => {
    /**
     * One-shot schedules always create a new conversation regardless of the
     * reuseConversation flag since they only fire once.
     */

    // GIVEN a one-shot schedule with reuseConversation enabled
    const schedule = createSchedule({
      name: "One-shot Reuse Ignored",
      message: "One-shot with reuse flag",
      mode: "execute",
      nextRunAt: Date.now() - 1000,
      reuseConversation: true,
      // No expression = one-shot
    });

    // WHEN the schedule fires
    const processMessage = async (conversationId: string, message: string) => {
      processedMessages.push({ conversationId, message });
    };

    const scheduler = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    // THEN the message is processed with a new conversation
    expect(processedMessages).toHaveLength(1);
    expect(processedMessages[0].conversationId).toBeTruthy();

    // AND the schedule is marked as fired
    const runs = getScheduleRuns(schedule.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe("ok");
  });

  test("reuseConversation uses the conversation from the most recent successful run", async () => {
    /**
     * When multiple runs exist, reuseConversation should pick the conversation
     * from the most recent successful run (not a failed one).
     */

    // GIVEN a recurring schedule with reuseConversation enabled
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = createSchedule({
      name: "Most Recent Success Test",
      cronExpression: rruleExpr,
      message: "Pick latest success",
      syntax: "rrule",
      expression: rruleExpr,
      reuseConversation: true,
    });

    // AND a first successful run
    forceScheduleDue(schedule.id);

    let shouldFail = false;
    const processMessage = async (conversationId: string, message: string) => {
      processedMessages.push({ conversationId, message });
      if (shouldFail) throw new Error("Simulated failure");
    };

    const scheduler1 = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler1.stop();

    expect(processedMessages).toHaveLength(1);
    const successConversationId = processedMessages[0].conversationId;

    // AND a second run that fails
    forceScheduleDue(schedule.id);
    processedMessages.length = 0;
    shouldFail = true;

    const scheduler2 = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler2.stop();

    // The failed run created a different conversation (since it failed
    // before the run could reuse — actually it does reuse the same one
    // because the lookup happens before the error). Let's verify the next
    // successful run still uses the original successful conversation.

    // AND a third run that succeeds
    forceScheduleDue(schedule.id);
    processedMessages.length = 0;
    shouldFail = false;

    const scheduler3 = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler3.stop();

    // THEN the third run reuses the conversation from the first successful run
    // (the lookup queries for status="ok", so it picks the first run's conversation)
    expect(processedMessages).toHaveLength(1);
    expect(processedMessages[0].conversationId).toBe(successConversationId);
  });
});

describe("scheduler talk-mode runner option propagation", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    processedMessages.length = 0;
    runBackgroundJobOptions.length = 0;
    runBackgroundJobShouldFail = false;
  });

  test("talk-mode propagates conversationType=scheduled, scheduleJobId, and quiet=>suppressFailureNotifications", async () => {
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = createSchedule({
      name: "Quiet Talk Mode",
      cronExpression: rruleExpr,
      message: "Background work",
      syntax: "rrule",
      expression: rruleExpr,
      quiet: true,
    });
    forceScheduleDue(schedule.id);

    const processMessage = async () => {};
    const scheduler = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    expect(runBackgroundJobOptions).toHaveLength(1);
    const opts = runBackgroundJobOptions[0]!;
    expect(opts.conversationType).toBe("scheduled");
    expect(opts.scheduleJobId).toBe(schedule.id);
    expect(opts.groupId).toBe("system:scheduled");
    expect(opts.suppressFailureNotifications).toBe(true);
  });

  test("talk-mode without quiet leaves suppressFailureNotifications=false", async () => {
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = createSchedule({
      name: "Loud Talk Mode",
      cronExpression: rruleExpr,
      message: "Background work",
      syntax: "rrule",
      expression: rruleExpr,
      // quiet defaults to false
    });
    forceScheduleDue(schedule.id);

    const processMessage = async () => {};
    const scheduler = startScheduler(processMessage, () => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    expect(runBackgroundJobOptions).toHaveLength(1);
    expect(runBackgroundJobOptions[0]!.suppressFailureNotifications).toBe(
      false,
    );
  });

  test("talk-mode fires onScheduleConversationCreated synchronously via runner callback (BEFORE the runner returns)", async () => {
    const rruleExpr = buildEveryMinuteRrule();
    const schedule = createSchedule({
      name: "SSE timing",
      cronExpression: rruleExpr,
      message: "x",
      syntax: "rrule",
      expression: rruleExpr,
    });
    forceScheduleDue(schedule.id);

    const sseCalls: Array<{
      conversationId: string;
      scheduleJobId: string;
      title: string;
    }> = [];
    const processMessage = async () => {};
    const scheduler = startScheduler(
      processMessage,
      () => {},
      undefined,
      (info) => sseCalls.push(info),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    scheduler.stop();

    expect(sseCalls).toHaveLength(1);
    expect(sseCalls[0]).toMatchObject({
      scheduleJobId: schedule.id,
      title: "SSE timing",
    });
    // The mock runner fires the callback synchronously after creating the
    // conversation row, so the conversationId must be the same id the runner
    // ultimately reports.
    expect(processedMessages).toHaveLength(1);
    expect(sseCalls[0].conversationId).toBe(
      processedMessages[0].conversationId,
    );
  });
});
