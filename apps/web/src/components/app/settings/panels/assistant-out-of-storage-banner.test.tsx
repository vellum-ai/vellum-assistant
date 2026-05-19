import { describe, expect, test } from "bun:test";

import type { AssistantsConnectionStatusResponse } from "@/generated/api/sdk.gen.js";

import { isOutOfStorageStatus } from "@/components/app/settings/panels/assistant-out-of-storage-banner.js";

function makeStatus(
  overrides: Partial<AssistantsConnectionStatusResponse>,
): AssistantsConnectionStatusResponse {
  return {
    state: "ready",
    is_awake: true,
    pod_status: "Running",
    waking_since: null,
    last_ready_at: null,
    crash_loop_since: null,
    detail: null,
    pod_error_kind: null,
    ...overrides,
  };
}

describe("isOutOfStorageStatus", () => {
  test("returns true when state is crash_loop and pod_error_kind is out_of_storage", () => {
    expect(
      isOutOfStorageStatus(
        makeStatus({
          state: "crash_loop",
          is_awake: false,
          pod_status: "ERROR",
          crash_loop_since: "2024-01-01T00:00:00Z",
          pod_error_kind: "out_of_storage",
          detail: "Assistant pod has run out of storage.",
        }),
      ),
    ).toBe(true);
  });

  test("returns false for crash_loop without out_of_storage classification", () => {
    expect(
      isOutOfStorageStatus(
        makeStatus({
          state: "crash_loop",
          is_awake: false,
          pod_status: "ERROR",
          crash_loop_since: "2024-01-01T00:00:00Z",
          pod_error_kind: null,
          detail: "Assistant pod is reporting an error.",
        }),
      ),
    ).toBe(false);
  });

  test("returns false for ready pods even if pod_error_kind is stale", () => {
    expect(
      isOutOfStorageStatus(
        makeStatus({
          state: "ready",
          pod_error_kind: "out_of_storage",
        }),
      ),
    ).toBe(false);
  });

  test("returns false for null / undefined payloads", () => {
    expect(isOutOfStorageStatus(null)).toBe(false);
    expect(isOutOfStorageStatus(undefined)).toBe(false);
  });
});
