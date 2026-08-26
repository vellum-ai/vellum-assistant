import { beforeEach, describe, expect, mock, test } from "bun:test";

const emitCalls: Array<Record<string, unknown>> = [];
mock.module("../emit-signal.js", () => ({
  emitNotificationSignal: (params: Record<string, unknown>) => {
    emitCalls.push(params);
    return Promise.resolve({
      signalId: "sig-1",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [],
      pipelineFailed: false,
    });
  },
}));

const { emitBackgroundFailureSignal } =
  await import("../background-failure-signal.js");

describe("emitBackgroundFailureSignal", () => {
  beforeEach(() => {
    emitCalls.length = 0;
  });

  test("carried connection leads the dedupe scope and rides the payload", () => {
    emitBackgroundFailureSignal({
      jobName: "schedule:job-1",
      displayName: "schedule:PR scan",
      sourceChannel: "scheduler",
      sourceContextId: "job-1",
      errorKind: "model_provider",
      errorMessage: "Agent turn failed (PROVIDER_BILLING)",
      failureCode: "PROVIDER_BILLING",
      failureSummary: "You're out of credits.",
      errorCategory: "credits_exhausted",
      connectionName: "conn-a",
      profileName: "balanced",
      fallbackProviderScope: "cost-optimized",
    });

    expect(emitCalls).toHaveLength(1);
    const emitted = emitCalls[0];
    expect(emitted.sourceEventName).toBe("activity.failed");
    expect(emitted.dedupeKey as string).toMatch(
      /^activity-failed:cause:PROVIDER_BILLING:conn-a:\d{4}-\d{2}-\d{2}$/,
    );
    expect(emitted.contextPayload).toMatchObject({
      jobName: "schedule:PR scan",
      errorKind: "model_provider",
      failureCode: "PROVIDER_BILLING",
      failureSummary: "You're out of credits.",
      errorCategory: "credits_exhausted",
      connectionName: "conn-a",
    });
  });

  test("carried profile scopes when no connection is carried", () => {
    emitBackgroundFailureSignal({
      jobName: "heartbeat",
      sourceChannel: "assistant_tool",
      sourceContextId: "conv-1",
      errorKind: "model_provider",
      errorMessage: "rate limited",
      failureCode: "PROVIDER_RATE_LIMIT",
      profileName: "balanced",
      fallbackProviderScope: "cost-optimized",
    });

    expect(emitCalls[0].dedupeKey as string).toMatch(
      /^activity-failed:cause:PROVIDER_RATE_LIMIT:balanced:\d{4}-\d{2}-\d{2}$/,
    );
  });

  test("recomputed fallback scopes when nothing is carried", () => {
    emitBackgroundFailureSignal({
      jobName: "watcher-a",
      sourceChannel: "assistant_tool",
      sourceContextId: "conv-2",
      errorKind: "model_provider",
      errorMessage: "provider returned 401",
      fallbackProviderScope: "cost-optimized",
    });

    expect(emitCalls[0].dedupeKey as string).toMatch(
      /^activity-failed:cause:model_provider:cost-optimized:\d{4}-\d{2}-\d{2}$/,
    );
  });

  test("no scope at all keys per job", () => {
    emitBackgroundFailureSignal({
      jobName: "memory.v2.sweep",
      sourceChannel: "scheduler",
      sourceContextId: "job-9",
      errorKind: "exception",
      errorMessage: "boom",
    });

    expect(emitCalls[0].dedupeKey as string).toMatch(
      /^activity-failed:memory\.v2\.sweep:\d{4}-\d{2}-\d{2}$/,
    );
    expect(emitCalls[0].contextPayload).toMatchObject({
      jobName: "memory.v2.sweep",
      errorKind: "exception",
    });
  });
});
