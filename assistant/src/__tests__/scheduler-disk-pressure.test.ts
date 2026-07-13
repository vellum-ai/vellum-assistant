import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: mock(() =>
    Promise.resolve({ invoked: true, producedToolCalls: false }),
  ),
}));

let locked = true;
mock.module("../daemon/disk-pressure-background-gate.js", () => ({
  checkDiskPressureBackgroundGate: () =>
    locked
      ? {
          action: "skip",
          reason: "disk_pressure",
          blockedCapability: "background-work",
          status: {
            enabled: true,
            state: "critical",
            locked: true,
            acknowledged: true,
            overrideActive: false,
            effectivelyLocked: true,
            lockId: "disk-pressure-test",
            usagePercent: 98,
            thresholdPercent: 95,
            path: "/",
            lastCheckedAt: "2026-05-05T00:00:00.000Z",
            blockedCapabilities: [
              "agent-turns",
              "background-work",
              "remote-ingress",
            ],
            error: null,
          },
        }
      : {
          action: "allow",
          status: {
            enabled: false,
            state: "disabled",
            locked: false,
            acknowledged: false,
            overrideActive: false,
            effectivelyLocked: false,
            lockId: null,
            usagePercent: null,
            thresholdPercent: 95,
            path: null,
            lastCheckedAt: null,
            blockedCapabilities: [],
            error: null,
          },
        },
  diskPressureBackgroundSkipLogFields: () => ({
    reason: "disk_pressure",
    thresholdPercent: 95,
    usagePercent: 98,
    blockedCapability: "background-work",
    lockId: "disk-pressure-test",
    path: "/",
  }),
  shouldLogDiskPressureBackgroundSkip: () => true,
}));

const mockProcessMessage = mock((..._args: unknown[]) => Promise.resolve());
mock.module("../daemon/process-message.js", () => ({
  processMessage: mockProcessMessage,
}));

const mockEmitNotificationSignal = mock((..._args: unknown[]) =>
  Promise.resolve(),
);
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: mockEmitNotificationSignal,
}));

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { createSchedule } from "../schedule/schedule-store.js";
import { runScheduleOnce } from "../schedule/scheduler.js";

await initializeDb();

function rawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

describe("scheduler disk pressure gate", () => {
  beforeEach(() => {
    locked = true;
    mockProcessMessage.mockClear();
    mockEmitNotificationSignal.mockClear();
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
    db.run("DELETE FROM task_runs");
    db.run("DELETE FROM tasks");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  });

  test("skips before claiming due schedules while disk pressure is locked", async () => {
    const dueAt = Date.now() - 10_000;
    const schedule = await createSchedule({
      name: "Due reminder",
      message: "Do not fire while locked",
      mode: "notify",
      nextRunAt: dueAt,
    });

    const processed = await runScheduleOnce();

    expect(processed).toBe(0);
    expect(mockProcessMessage).not.toHaveBeenCalled();
    expect(mockEmitNotificationSignal).not.toHaveBeenCalled();

    const row = rawDb()
      .query("SELECT status, next_run_at FROM cron_jobs WHERE id = ?")
      .get(schedule.id) as { status: string; next_run_at: number } | null;
    expect(row).toEqual({ status: "active", next_run_at: dueAt });

    const runCount = rawDb()
      .query("SELECT COUNT(*) AS count FROM cron_runs")
      .get() as { count: number };
    expect(runCount.count).toBe(0);
  });
});
