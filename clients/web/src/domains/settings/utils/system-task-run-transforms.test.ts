import { describe, expect, test } from "bun:test";

import {
  selectHeartbeatRuns,
  toScheduleRun,
  type AnySystemTaskRun,
} from "@/domains/settings/utils/system-task-run-transforms";

import type { HeartbeatRunsGetResponse } from "@/generated/daemon/types.gen";

type HeartbeatRun = HeartbeatRunsGetResponse["runs"][number];

function heartbeatRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-1",
    scheduledFor: 1_000,
    startedAt: 1_000,
    finishedAt: 2_000,
    durationMs: 1_000,
    status: "ok",
    skipReason: null,
    error: null,
    conversationId: null,
    conversationExists: false,
    conversationArchivedAt: null,
    estimatedCostUsd: 0,
    createdAt: 1_000,
    ...overrides,
  };
}

describe("toScheduleRun", () => {
  test("skipped runs carry a human-readable skip reason", () => {
    const mapped = toScheduleRun(
      heartbeatRun({
        status: "skipped",
        skipReason: "outside_active_hours",
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      }),
      "heartbeat",
    );

    expect(mapped.output).toBe("Skipped — outside active hours");
  });

  test("unknown skip reasons fall back to the raw code", () => {
    const mapped = toScheduleRun(
      heartbeatRun({ status: "skipped", skipReason: "future_reason" }),
      "heartbeat",
    );

    expect(mapped.output).toBe("Skipped — future_reason");
  });

  test("missed runs explain the gap", () => {
    const mapped = toScheduleRun(
      heartbeatRun({
        status: "missed",
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      }),
      "heartbeat",
    );

    expect(mapped.output).toBe("Missed while the assistant was offline");
  });

  test("executed runs have no unexecuted-run text", () => {
    const mapped = toScheduleRun(
      heartbeatRun({ status: "ok" }) as AnySystemTaskRun,
      "heartbeat",
    );

    expect(mapped.output).toBeNull();
  });
});

describe("selectHeartbeatRuns", () => {
  test("hides bookkeeping rows (pending, superseded) sent by older daemons", () => {
    const response: HeartbeatRunsGetResponse = {
      nextCursor: null,
      runs: [
        heartbeatRun({
          id: "next-scheduled",
          status: "pending",
          scheduledFor: 10_000,
          startedAt: null,
          finishedAt: null,
        }),
        heartbeatRun({
          id: "timer-reset",
          status: "superseded",
          scheduledFor: 9_000,
          startedAt: null,
          finishedAt: null,
        }),
        heartbeatRun({ id: "real-run", status: "ok" }),
        heartbeatRun({
          id: "skipped-run",
          status: "skipped",
          skipReason: "max_consecutive_runs",
        }),
      ],
    };

    expect(selectHeartbeatRuns(response).map((r) => r.id)).toEqual([
      "real-run",
      "skipped-run",
    ]);
  });
});
