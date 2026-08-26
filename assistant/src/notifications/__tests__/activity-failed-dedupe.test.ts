import { describe, expect, test } from "bun:test";

import { activityFailedDedupeKey } from "../activity-failed-dedupe.js";

describe("activityFailedDedupeKey", () => {
  test("a provider-scoped code collapses across jobs within one scope", () => {
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
      /^activity-failed:cause:PROVIDER_BILLING:default:\d{4}-\d{2}-\d{2}$/,
    );
  });

  test("the same code in different provider scopes stays distinct", () => {
    // Two provider connections can fail for the same class of reason with
    // different remedies; the first notification must not hide the second.
    const profileA = activityFailedDedupeKey({
      jobName: "schedule:job-a",
      errorKind: "model_provider",
      failureCode: "PROVIDER_INVALID_KEY",
      providerScope: "profile-a",
    });
    const profileB = activityFailedDedupeKey({
      jobName: "schedule:job-b",
      errorKind: "model_provider",
      failureCode: "PROVIDER_INVALID_KEY",
      providerScope: "profile-b",
    });
    expect(profileA).not.toBe(profileB);
    expect(profileA).toMatch(
      /^activity-failed:cause:PROVIDER_INVALID_KEY:profile-a:\d{4}-\d{2}-\d{2}$/,
    );
  });

  test("a workspace-wide code collapses regardless of provider scope", () => {
    const a = activityFailedDedupeKey({
      jobName: "job-a",
      errorKind: "model_provider",
      failureCode: "MANAGED_KEY_INVALID",
      providerScope: "profile-a",
    });
    const b = activityFailedDedupeKey({
      jobName: "job-b",
      errorKind: "model_provider",
      failureCode: "MANAGED_KEY_INVALID",
      providerScope: "profile-b",
    });
    expect(a).toBe(b);
    expect(a).toMatch(
      /^activity-failed:cause:MANAGED_KEY_INVALID:\d{4}-\d{2}-\d{2}$/,
    );
  });

  test("job-specific failure codes key per job, not on the cause", () => {
    const a = activityFailedDedupeKey({
      jobName: "job-a",
      errorKind: "model_provider",
      failureCode: "CONTEXT_TOO_LARGE",
    });
    const b = activityFailedDedupeKey({
      jobName: "job-b",
      errorKind: "model_provider",
      failureCode: "CONTEXT_TOO_LARGE",
    });
    expect(a).toMatch(/^activity-failed:job-a:\d{4}-\d{2}-\d{2}$/);
    expect(a).not.toBe(b);
  });

  test("unknown failure codes default to the per-job key", () => {
    const key = activityFailedDedupeKey({
      jobName: "job-a",
      errorKind: "model_provider",
      failureCode: "SOME_FUTURE_CODE",
    });
    expect(key).toMatch(/^activity-failed:job-a:\d{4}-\d{2}-\d{2}$/);
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
      /^activity-failed:cause:model_provider:default:\d{4}-\d{2}-\d{2}$/,
    );
    const scoped = activityFailedDedupeKey({
      jobName: "watcher-a",
      errorKind: "model_provider",
      providerScope: "profile-a",
    });
    expect(scoped).not.toBe(a);
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
