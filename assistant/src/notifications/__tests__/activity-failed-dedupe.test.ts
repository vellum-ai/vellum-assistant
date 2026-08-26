import { describe, expect, test } from "bun:test";

import { activityFailedDedupeKey } from "../activity-failed-dedupe.js";

describe("activityFailedDedupeKey", () => {
  test("a failure code keys on the cause, whatever the job", () => {
    const heartbeat = activityFailedDedupeKey({
      jobName: "heartbeat",
      errorKind: "model_provider",
      failureCode: "PROVIDER_BILLING",
    });
    const schedule = activityFailedDedupeKey({
      jobName: "schedule:job-123",
      errorKind: "model_provider",
      failureCode: "PROVIDER_BILLING",
    });
    expect(heartbeat).toBe(schedule);
    expect(heartbeat).toMatch(
      /^activity-failed:cause:PROVIDER_BILLING:\d{4}-\d{2}-\d{2}$/,
    );
  });

  test("distinct failure codes stay distinct", () => {
    const billing = activityFailedDedupeKey({
      jobName: "job",
      errorKind: "model_provider",
      failureCode: "PROVIDER_BILLING",
    });
    const key = activityFailedDedupeKey({
      jobName: "job",
      errorKind: "model_provider",
      failureCode: "MANAGED_KEY_INVALID",
    });
    expect(billing).not.toBe(key);
  });

  test("code-less provider failures share the model_provider cause key", () => {
    const a = activityFailedDedupeKey({
      jobName: "watcher-a",
      errorKind: "model_provider",
    });
    const b = activityFailedDedupeKey({
      jobName: "watcher-b",
      errorKind: "model_provider",
    });
    expect(a).toBe(b);
    expect(a).toMatch(
      /^activity-failed:cause:model_provider:\d{4}-\d{2}-\d{2}$/,
    );
  });

  test("job-specific failures key per job", () => {
    const timeoutA = activityFailedDedupeKey({
      jobName: "job-a",
      errorKind: "timeout",
    });
    const timeoutB = activityFailedDedupeKey({
      jobName: "job-b",
      errorKind: "timeout",
    });
    const exceptionA = activityFailedDedupeKey({
      jobName: "job-a",
      errorKind: "exception",
    });
    expect(timeoutA).toMatch(/^activity-failed:job-a:\d{4}-\d{2}-\d{2}$/);
    expect(timeoutA).not.toBe(timeoutB);
    expect(exceptionA).toMatch(/^activity-failed:job-a:\d{4}-\d{2}-\d{2}$/);
  });
});
