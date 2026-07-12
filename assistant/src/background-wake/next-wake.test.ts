import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../__tests__/helpers/set-config.js";

type MockHeartbeatConfig = {
  enabled: boolean;
  intervalMs: number;
  cronExpression: string | null;
  timezone: string | null;
  activeHoursStart: number | null;
  activeHoursEnd: number | null;
  maxConsecutiveRuns: number | null;
};

type MockSchedule = {
  id: string;
  nextRunAt: number;
  enabled: boolean;
  mode: "notify" | "execute" | "script" | "wake";
  createdBy: string;
  status: "active" | "firing" | "fired" | "cancelled";
  syntax: "cron" | "rrule";
  expression: string | null;
  timezone: string | null;
  updatedAt: number;
};

let heartbeatConfig: MockHeartbeatConfig;
let heartbeatNextRunAt: number | null;
let heartbeatConsecutiveRunCapReached: boolean;
let schedules: MockSchedule[];
let computedCronNextRunAt: number;

mock.module("../heartbeat/heartbeat-service.js", () => ({
  HeartbeatService: {
    getInstance: () =>
      heartbeatNextRunAt == null
        ? undefined
        : {
            nextRunAt: heartbeatNextRunAt,
            isConsecutiveRunCapReached: heartbeatConsecutiveRunCapReached,
          },
  },
}));

mock.module("../schedule/recurrence-engine.js", () => ({
  computeNextRunAt: () => computedCronNextRunAt,
}));

mock.module("../schedule/schedule-store.js", () => ({
  listSchedules: (options?: { enabledOnly?: boolean }) =>
    options?.enabledOnly
      ? schedules.filter((schedule) => schedule.enabled)
      : schedules,
}));

const { computeNextBackgroundWakeIntent } = await import("./next-wake.js");

// Seed the current heartbeat config for real before invoking the intent
// computer, mirroring the per-call read the old getConfig mock provided.
function computeWakeIntent(now: number) {
  setConfig("heartbeat", heartbeatConfig);
  return computeNextBackgroundWakeIntent(now);
}

const NOW = 1_800_000_000_000;

describe("computeNextBackgroundWakeIntent", () => {
  beforeEach(() => {
    heartbeatConfig = {
      enabled: true,
      intervalMs: 30 * 60_000,
      cronExpression: null,
      timezone: null,
      activeHoursStart: 8,
      activeHoursEnd: 22,
      maxConsecutiveRuns: 3,
    };
    heartbeatNextRunAt = null;
    heartbeatConsecutiveRunCapReached = false;
    schedules = [];
    computedCronNextRunAt = NOW + 3_600_000;
  });

  test("returns heartbeat-only interval wake intent", () => {
    const intent = computeWakeIntent(NOW);

    expect(intent).not.toBeNull();
    expect(intent!.nextWakeAt).toBe(NOW + heartbeatConfig.intervalMs);
    expect(intent!.actualNextDueAt).toBe(NOW + heartbeatConfig.intervalMs);
    expect(intent!.reason).toBe("heartbeat");
    expect(intent!.sourcePayload.heartbeat).toMatchObject({
      nextRunAt: NOW + heartbeatConfig.intervalMs,
      mode: "interval",
      intervalMs: heartbeatConfig.intervalMs,
      cronExpression: null,
    });
    expect(intent!.sourcePayload.schedules).toEqual([]);
  });

  test("uses the running heartbeat service next run when available", () => {
    heartbeatNextRunAt = NOW + 12_345;

    const intent = computeWakeIntent(NOW);

    expect(intent).not.toBeNull();
    expect(intent!.nextWakeAt).toBe(heartbeatNextRunAt);
    expect(intent!.actualNextDueAt).toBe(heartbeatNextRunAt);
    expect(intent!.reason).toBe("heartbeat");
  });

  test("returns heartbeat-only cron wake intent", () => {
    heartbeatConfig.cronExpression = "0 9 * * *";
    heartbeatConfig.timezone = "America/New_York";
    computedCronNextRunAt = NOW + 42_000;

    const intent = computeWakeIntent(NOW);

    expect(intent).not.toBeNull();
    expect(intent!.nextWakeAt).toBe(computedCronNextRunAt);
    expect(intent!.reason).toBe("heartbeat");
    expect(intent!.sourcePayload.heartbeat).toMatchObject({
      nextRunAt: computedCronNextRunAt,
      mode: "cron",
      cronExpression: "0 9 * * *",
      timezone: "America/New_York",
    });
  });

  test("returns schedule-only wake intent", () => {
    heartbeatConfig.enabled = false;
    schedules = [
      scheduleFixture({
        id: "schedule-later",
        nextRunAt: NOW + 60_000,
      }),
      scheduleFixture({
        id: "schedule-sooner",
        nextRunAt: NOW + 30_000,
      }),
    ];

    const intent = computeWakeIntent(NOW);

    expect(intent).not.toBeNull();
    expect(intent!.nextWakeAt).toBe(NOW + 30_000);
    expect(intent!.actualNextDueAt).toBe(NOW + 30_000);
    expect(intent!.reason).toBe("schedule");
    expect(intent!.sourcePayload.heartbeat).toBeNull();
    expect(intent!.sourcePayload.schedules.map((s) => s.id)).toEqual([
      "schedule-sooner",
      "schedule-later",
    ]);
  });

  test("includes defer-created wake schedules", () => {
    heartbeatConfig.enabled = false;
    schedules = [
      scheduleFixture({
        id: "defer-wake",
        nextRunAt: NOW + 10_000,
        mode: "wake",
        createdBy: "defer",
      }),
    ];

    const intent = computeWakeIntent(NOW);

    expect(intent).not.toBeNull();
    expect(intent!.nextWakeAt).toBe(NOW + 10_000);
    expect(intent!.sourcePayload.schedules).toEqual([
      expect.objectContaining({
        id: "defer-wake",
        mode: "wake",
        createdBy: "defer",
      }),
    ]);
  });

  test("returns mixed when heartbeat and schedule are co-due", () => {
    heartbeatNextRunAt = NOW + 50_000;
    schedules = [
      scheduleFixture({
        id: "co-due",
        nextRunAt: NOW + 50_000,
      }),
    ];

    const intent = computeWakeIntent(NOW);

    expect(intent).not.toBeNull();
    expect(intent!.nextWakeAt).toBe(NOW + 50_000);
    expect(intent!.actualNextDueAt).toBe(NOW + 50_000);
    expect(intent!.reason).toBe("mixed");
  });

  test("ignores disabled heartbeat and disabled schedules", () => {
    heartbeatConfig.enabled = false;
    schedules = [
      scheduleFixture({
        id: "disabled",
        enabled: false,
        nextRunAt: NOW + 10_000,
      }),
    ];

    expect(computeWakeIntent(NOW)).toBeNull();
  });

  test("ignores inactive enabled schedules", () => {
    heartbeatConfig.enabled = false;
    schedules = [
      scheduleFixture({
        id: "fired",
        status: "fired",
        nextRunAt: NOW + 10_000,
      }),
      scheduleFixture({
        id: "zero",
        nextRunAt: 0,
      }),
    ];

    expect(computeWakeIntent(NOW)).toBeNull();
  });

  test("reports far-future due work without applying storage horizon", () => {
    heartbeatConfig.enabled = false;
    const actualNextDueAt = NOW + 45 * 24 * 60 * 60 * 1000;
    schedules = [
      scheduleFixture({
        id: "far-future",
        nextRunAt: actualNextDueAt,
      }),
    ];

    const intent = computeWakeIntent(NOW);

    expect(intent).not.toBeNull();
    expect(intent!.reason).toBe("schedule");
    expect(intent!.actualNextDueAt).toBe(actualNextDueAt);
    expect(intent!.nextWakeAt).toBe(actualNextDueAt);
  });

  test("sets computedAt to the local snapshot time", () => {
    heartbeatConfig.enabled = false;
    schedules = [
      scheduleFixture({
        id: "scheduled",
        nextRunAt: NOW + 10_000,
      }),
    ];
    const before = Date.now();

    const intent = computeWakeIntent(NOW);

    const after = Date.now();
    expect(intent).not.toBeNull();
    expect(intent!.computedAt).toBeGreaterThanOrEqual(before);
    expect(intent!.computedAt).toBeLessThanOrEqual(after);
  });

  test("keeps sourceGeneration stable for unchanged sources", async () => {
    heartbeatNextRunAt = NOW + 10_000;
    schedules = [
      scheduleFixture({
        id: "scheduled",
        nextRunAt: NOW + 20_000,
      }),
    ];

    const first = computeWakeIntent(NOW);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = computeWakeIntent(NOW);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.computedAt).not.toBe(second!.computedAt);
    expect(first!.sourceGeneration).toBe(second!.sourceGeneration);
  });

  test("returns null when heartbeat consecutive run cap is reached and no schedules", () => {
    heartbeatNextRunAt = NOW + 30_000;
    heartbeatConsecutiveRunCapReached = true;

    expect(computeWakeIntent(NOW)).toBeNull();
  });

  test("returns schedule-only intent when heartbeat consecutive run cap is reached", () => {
    heartbeatNextRunAt = NOW + 30_000;
    heartbeatConsecutiveRunCapReached = true;
    schedules = [
      scheduleFixture({
        id: "still-active",
        nextRunAt: NOW + 60_000,
      }),
    ];

    const intent = computeWakeIntent(NOW);

    expect(intent).not.toBeNull();
    expect(intent!.reason).toBe("schedule");
    expect(intent!.sourcePayload.heartbeat).toBeNull();
    expect(intent!.sourcePayload.schedules).toHaveLength(1);
  });
});

function scheduleFixture(overrides: Partial<MockSchedule>): MockSchedule {
  return {
    id: "schedule",
    nextRunAt: NOW + 60_000,
    enabled: true,
    mode: "execute",
    createdBy: "agent",
    status: "active",
    syntax: "cron",
    expression: "*/5 * * * *",
    timezone: null,
    updatedAt: NOW - 1_000,
    ...overrides,
  };
}
