import { afterEach, describe, expect, mock, test } from "bun:test";

import * as sdkGen from "@/generated/daemon/sdk.gen";

import type {
  ConsolidationRunsGetResponse,
  HeartbeatRunsGetResponse,
  RetrospectiveRunsGetResponse,
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

interface ConsolidationRunsCall {
  path: { assistant_id: string };
  query: { limit: number };
  throwOnError: false;
}

interface HeartbeatRunsCall {
  path: { assistant_id: string };
  query: { limit: number };
  throwOnError: false;
}

interface ConfigUpdateCall {
  path: { assistant_id: string };
  body: { enabled: boolean };
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

const consolidationRows: ConsolidationRunsGetResponse["runs"] = [
  {
    id: "conv-consolidation-1",
    scheduledFor: 1_761_792_000_000,
    startedAt: 1_761_792_001_000,
    finishedAt: 1_761_792_004_000,
    durationMs: 3000,
    status: "ok",
    skipReason: null,
    error: null,
    conversationId: "conv-consolidation-1",
    conversationExists: true,
    conversationArchivedAt: null,
    estimatedCostUsd: 0.1234,
    createdAt: 1_761_792_000_000,
  },
];

const retrospectiveRows: RetrospectiveRunsGetResponse["runs"] = [
  {
    id: "conv-retro-1",
    scheduledFor: 1_761_792_000_000,
    startedAt: 1_761_792_001_000,
    finishedAt: 1_761_792_004_000,
    durationMs: 3000,
    status: "ok",
    skipReason: null,
    error: null,
    conversationId: "conv-retro-1",
    conversationExists: true,
    conversationArchivedAt: null,
    estimatedCostUsd: 0.0456,
    createdAt: 1_761_792_000_000,
    kind: "fork",
    title: "Planning chat (Retrospective)",
  },
];

const heartbeatRows: HeartbeatRunsGetResponse["runs"] = [
  {
    id: "heartbeat-run-1",
    scheduledFor: 1_761_792_000_000,
    startedAt: 1_761_792_001_000,
    finishedAt: 1_761_792_004_000,
    durationMs: 3000,
    status: "ok",
    skipReason: null,
    error: null,
    conversationId: "conv-heartbeat-1",
    conversationExists: true,
    conversationArchivedAt: null,
    estimatedCostUsd: 0.0567,
    createdAt: 1_761_792_000_000,
  },
];

let usageSummaryCalls: UsageSummaryCall[] = [];
let schedulesCalls: SchedulesCall[] = [];
let consolidationRunsCalls: ConsolidationRunsCall[] = [];
let retrospectiveRunsCalls: ConsolidationRunsCall[] = [];
let heartbeatRunsCalls: HeartbeatRunsCall[] = [];
let heartbeatConfigPutCalls: ConfigUpdateCall[] = [];
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
  consolidationRunsGet: (opts: ConsolidationRunsCall) => {
    consolidationRunsCalls.push(opts);
    return Promise.resolve({
      data: responseOk ? { runs: consolidationRows } : undefined,
      error: undefined,
      response: { ok: responseOk, status: responseStatus },
    });
  },
  retrospectiveRunsGet: (opts: ConsolidationRunsCall) => {
    retrospectiveRunsCalls.push(opts);
    return Promise.resolve({
      data: responseOk ? { runs: retrospectiveRows } : undefined,
      error: undefined,
      response: { ok: responseOk, status: responseStatus },
    });
  },
  heartbeatRunsGet: (opts: HeartbeatRunsCall) => {
    heartbeatRunsCalls.push(opts);
    return Promise.resolve({
      data: responseOk ? { runs: heartbeatRows } : undefined,
      error: undefined,
      response: { ok: responseOk, status: responseStatus },
    });
  },
  heartbeatConfigPut: (opts: ConfigUpdateCall) => {
    heartbeatConfigPutCalls.push(opts);
    return Promise.resolve({
      data: responseOk
        ? {
            enabled: opts.body.enabled,
            intervalMs: 60 * 60_000,
            activeHoursStart: 8,
            activeHoursEnd: 22,
            cronExpression: null,
            timezone: null,
            nextRunAt: opts.body.enabled ? 1_761_792_000_000 : null,
            lastRunAt: null,
            success: true,
          }
        : undefined,
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
  fetchConsolidationRuns,
  fetchHeartbeatRuns,
  fetchRetrospectiveRuns,
  fetchScheduleUsageSummary,
  updateHeartbeatConfig,
} = await import("./schedules");

afterEach(() => {
  usageSummaryCalls = [];
  schedulesCalls = [];
  consolidationRunsCalls = [];
  retrospectiveRunsCalls = [];
  heartbeatRunsCalls = [];
  heartbeatConfigPutCalls = [];
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

describe("fetchHeartbeatRuns", () => {
  test("preserves conversation availability and cost metadata", async () => {
    const result = await fetchHeartbeatRuns("assistant-1");

    expect(heartbeatRunsCalls).toEqual([
      {
        path: { assistant_id: "assistant-1" },
        query: { limit: 10 },
        throwOnError: false,
      },
    ]);
    expect(result).toEqual({
      runs: [
        {
          id: "heartbeat-run-1",
          jobId: "heartbeat",
          status: "ok",
          startedAt: 1_761_792_001_000,
          finishedAt: 1_761_792_004_000,
          durationMs: 3000,
          output: null,
          error: null,
          conversationId: "conv-heartbeat-1",
          conversationExists: true,
          conversationArchivedAt: null,
          estimatedCostUsd: 0.0567,
          createdAt: 1_761_792_000_000,
        },
      ],
      nextCursor: null,
    });
  });
});

describe("fetchConsolidationRuns", () => {
  test("maps daemon consolidation runs into shared schedule run rows", async () => {
    const result = await fetchConsolidationRuns("assistant-1");

    expect(consolidationRunsCalls).toEqual([
      {
        path: { assistant_id: "assistant-1" },
        query: { limit: 10 },
        throwOnError: false,
      },
    ]);
    expect(result).toEqual({
      runs: [
        {
          id: "conv-consolidation-1",
          jobId: "consolidation",
          status: "ok",
          startedAt: 1_761_792_001_000,
          finishedAt: 1_761_792_004_000,
          durationMs: 3000,
          output: null,
          error: null,
          conversationId: "conv-consolidation-1",
          conversationExists: true,
          conversationArchivedAt: null,
          estimatedCostUsd: 0.1234,
          createdAt: 1_761_792_000_000,
        },
      ],
      nextCursor: null,
    });
  });
});

describe("fetchRetrospectiveRuns", () => {
  test("maps daemon retrospective runs into shared schedule run rows with the title", async () => {
    const result = await fetchRetrospectiveRuns("assistant-1");

    expect(retrospectiveRunsCalls).toEqual([
      {
        path: { assistant_id: "assistant-1" },
        query: { limit: 10 },
        throwOnError: false,
      },
    ]);
    expect(result).toEqual({
      runs: [
        {
          id: "conv-retro-1",
          jobId: "retrospective",
          status: "ok",
          startedAt: 1_761_792_001_000,
          finishedAt: 1_761_792_004_000,
          durationMs: 3000,
          output: null,
          error: null,
          conversationId: "conv-retro-1",
          conversationExists: true,
          conversationArchivedAt: null,
          estimatedCostUsd: 0.0456,
          createdAt: 1_761_792_000_000,
          title: "Planning chat (Retrospective)",
        },
      ],
      nextCursor: null,
    });
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

describe("system task config updates", () => {
  test("updates heartbeat enabled through the daemon config endpoint", async () => {
    const result = await updateHeartbeatConfig("assistant-1", {
      enabled: false,
    });

    expect(result.enabled).toBe(false);
    expect(heartbeatConfigPutCalls).toEqual([
      {
        path: { assistant_id: "assistant-1" },
        body: { enabled: false },
        throwOnError: false,
      },
    ]);
  });

});
