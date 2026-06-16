import { afterEach, describe, expect, mock, test } from "bun:test";

import * as sdkGen from "@/generated/daemon/sdk.gen";

import type {
  SchedulesGetResponse,
  SchedulesUsagesummaryGetResponse,
} from "@/generated/daemon/types.gen";

interface SchedulesCall {
  path: { assistant_id: string };
  throwOnError: false;
}

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
let schedulesCalls: SchedulesCall[] = [];
let scheduleRows: SchedulesGetResponse["schedules"] = [];
let responseOk = true;
let responseStatus = 200;

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  schedulesGet: (opts: SchedulesCall) => {
    schedulesCalls.push(opts);
    return Promise.resolve({
      data: responseOk ? { schedules: scheduleRows } : undefined,
      error: undefined,
      response: { ok: responseOk, status: responseStatus },
    });
  },
  schedulesUsagesummaryGet: (opts: UsageSummaryCall) => {
    usageSummaryCalls.push(opts);
    return Promise.resolve({
      data: responseOk ? { summaries: summaryRows } : undefined,
      error: undefined,
      response: { ok: responseOk, status: responseStatus },
    });
  },
}));

const {
  fetchSchedules,
  fetchScheduleUsageSummary,
} = await import("./schedules");

afterEach(() => {
  usageSummaryCalls = [];
  schedulesCalls = [];
  scheduleRows = [];
  responseOk = true;
  responseStatus = 200;
});

describe("fetchSchedules", () => {
  test("falls back to description when older assistants omit cadenceDescription", async () => {
    scheduleRows = [
      {
        id: "schedule-123",
        name: "Morning brief",
        enabled: true,
        syntax: "cron",
        expression: "0 9 * * *",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        message: "Send the morning brief",
        script: null,
        nextRunAt: 1_761_792_000_000,
        lastRunAt: null,
        lastStatus: null,
        retryCount: 0,
        maxRetries: 0,
        retryBackoffMs: 60_000,
        timeoutMs: null,
        createdFromConversationId: null,
        createdFromConversationExists: false,
        createdFromConversationArchivedAt: null,
        description: "Every day at 9:00 AM",
        mode: "execute",
        status: "active",
        routingIntent: "all_channels",
        reuseConversation: true,
        wakeConversationId: null,
        isOneShot: false,
      },
    ] as unknown as SchedulesGetResponse["schedules"];

    const result = await fetchSchedules("assistant-1");

    expect(schedulesCalls).toEqual([
      {
        path: { assistant_id: "assistant-1" },
        throwOnError: false,
      },
    ]);
    expect(result[0]?.description).toBe("Every day at 9:00 AM");
    expect(result[0]?.cadenceDescription).toBe("Every day at 9:00 AM");
  });
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


