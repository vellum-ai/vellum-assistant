import { describe, expect, mock, test } from "bun:test";

import {
  summarizeRunsForUsage,
  SYSTEM_TASK_URL_IDS,
} from "./schedule-formatters";
import { fetchSystemTaskRunsForUsage } from "./system-task-run-transforms";

import type { HeartbeatRunsGetResponse } from "@/generated/daemon/types.gen";

type HeartbeatRun = HeartbeatRunsGetResponse["runs"][number];

function heartbeatRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "heartbeat-run",
    scheduledFor: 1_761_792_000_000,
    startedAt: 1_761_792_000_000,
    finishedAt: 1_761_792_010_000,
    durationMs: 10_000,
    status: "ok",
    skipReason: null,
    error: null,
    conversationId: "conv-run",
    conversationExists: true,
    conversationArchivedAt: null,
    estimatedCostUsd: 0.02,
    createdAt: 1_761_792_000_000,
    ...overrides,
  };
}

describe("fetchSystemTaskRunsForUsage", () => {
  test("continues past a skipped-only capped page until the usage window is covered", async () => {
    const fetchPage = mock(async (before: number | undefined) => {
      if (before == null) {
        return {
          runs: [
            heartbeatRun({
              id: "heartbeat-skipped",
              status: "skipped",
              skipReason: "max_daily_runs",
              conversationId: null,
              estimatedCostUsd: 0,
            }),
          ],
          nextCursor: 1_761_791_990_000,
        };
      }

      return {
        runs: [
          heartbeatRun({
            id: "heartbeat-ok",
            scheduledFor: 1_761_791_990_000,
            startedAt: 1_761_791_990_000,
            createdAt: 1_761_791_990_000,
            estimatedCostUsd: 0.02,
          }),
        ],
        nextCursor: null,
      };
    });

    const runs = await fetchSystemTaskRunsForUsage({
      kind: "heartbeat",
      range: { from: 1_761_791_000_000, to: 1_761_793_000_000 },
      fetchPage,
    });
    const summary = summarizeRunsForUsage(
      SYSTEM_TASK_URL_IDS.heartbeat,
      runs,
      { from: 1_761_791_000_000, to: 1_761_793_000_000 },
    );

    expect(fetchPage.mock.calls.map(([before]) => before)).toEqual([
      undefined,
      1_761_791_990_000,
    ]);
    expect(summary.runCount).toBe(1);
    expect(summary.totalEstimatedCostUsd).toBe(0.02);
  });

  test("stops after the page that reaches older runs", async () => {
    const fetchPage = mock(async (before: number | undefined) => ({
      runs: [
        heartbeatRun({
          id: before == null ? "heartbeat-new" : "heartbeat-old",
          scheduledFor:
            before == null ? 1_761_792_000_000 : 1_761_790_999_999,
          startedAt:
            before == null ? 1_761_792_000_000 : 1_761_790_999_999,
          createdAt:
            before == null ? 1_761_792_000_000 : 1_761_790_999_999,
        }),
      ],
      nextCursor: before == null ? 1_761_791_990_000 : 1_761_790_000_000,
    }));

    await fetchSystemTaskRunsForUsage({
      kind: "heartbeat",
      range: { from: 1_761_791_000_000, to: 1_761_793_000_000 },
      fetchPage,
    });

    expect(fetchPage.mock.calls.map(([before]) => before)).toEqual([
      undefined,
      1_761_791_990_000,
    ]);
  });
});
