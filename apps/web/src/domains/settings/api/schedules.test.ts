import { afterEach, describe, expect, mock, test } from "bun:test";

import * as sdkGen from "@/generated/daemon/sdk.gen";

import type { SchedulesUsagesummaryGetResponse } from "@/generated/daemon/types.gen";

interface UsageSummaryCall {
  path: { assistant_id: string };
  query: { from: number; to: number };
  throwOnError: false;
}

const summaryRows: SchedulesUsagesummaryGetResponse["summaries"] = [
  {
    scheduleId: "schedule-123",
    runCount: 2,
    totalEstimatedCostUsd: 0.42,
    eventCount: 7,
  },
];

let usageSummaryCalls: UsageSummaryCall[] = [];
let responseOk = true;
let responseStatus = 200;

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  schedulesUsagesummaryGet: (opts: UsageSummaryCall) => {
    usageSummaryCalls.push(opts);
    return Promise.resolve({
      data: responseOk ? { summaries: summaryRows } : undefined,
      error: undefined,
      response: { ok: responseOk, status: responseStatus },
    });
  },
}));

const { fetchScheduleUsageSummary } = await import("./schedules");

afterEach(() => {
  usageSummaryCalls = [];
  responseOk = true;
  responseStatus = 200;
});

describe("fetchScheduleUsageSummary", () => {
  test("passes summary range query params to the daemon SDK", async () => {
    const result = await fetchScheduleUsageSummary("assistant-1", {
      from: 100,
      to: 200,
    });

    expect(result).toEqual(summaryRows);
    expect(usageSummaryCalls).toEqual([
      {
        path: { assistant_id: "assistant-1" },
        query: { from: 100, to: 200 },
        throwOnError: false,
      },
    ]);
  });

  test("preserves from=0 in summary query params", async () => {
    await fetchScheduleUsageSummary("assistant-1", {
      from: 0,
      to: 200,
    });

    expect(usageSummaryCalls[0]?.query).toEqual({ from: 0, to: 200 });
  });
});
