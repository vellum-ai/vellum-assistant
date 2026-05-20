import { describe, expect, test } from "bun:test";

import {
  shouldDeferReachabilityOverlay,
  shouldFailReachabilityImmediately,
} from "@/domains/assistant/use-assistant-reachability.js";
import type { ConnectionStatus } from "@/generated/api/index.js";

function fakeResponse(
  overrides: Partial<ConnectionStatus> = {},
): ConnectionStatus {
  return {
    state: "waking",
    is_awake: false,
    pod_status: null,
    waking_since: null,
    last_ready_at: null,
    crash_loop_since: null,
    detail: null,
    ...overrides,
  };
}

describe("assistant reachability", () => {
  test("fails immediately for crash-looping pods", () => {
    expect(shouldFailReachabilityImmediately("crash_loop")).toBe(true);
  });

  test("does not fail immediately for transient states", () => {
    expect(shouldFailReachabilityImmediately("ready")).toBe(false);
    expect(shouldFailReachabilityImmediately("waking")).toBe(false);
    expect(shouldFailReachabilityImmediately("unreachable")).toBe(false);
  });

  test("fails immediately when state is waking but crash_loop_since is set", () => {
    const response = fakeResponse({
      state: "waking",
      crash_loop_since: "2026-01-01T00:00:00Z",
    });
    expect(shouldFailReachabilityImmediately("waking", response)).toBe(true);
  });

  test("does not fail for waking when crash_loop_since is null", () => {
    const response = fakeResponse({ state: "waking", crash_loop_since: null });
    expect(shouldFailReachabilityImmediately("waking", response)).toBe(false);
  });

  test("does not fail for unreachable even when crash_loop_since is set", () => {
    const response = fakeResponse({
      state: "unreachable",
      crash_loop_since: "2026-01-01T00:00:00Z",
    });
    expect(
      shouldFailReachabilityImmediately("unreachable", response),
    ).toBe(false);
  });

  test("does not fail for not_found even when crash_loop_since is set", () => {
    const response = fakeResponse({
      state: "not_found",
      crash_loop_since: "2026-01-01T00:00:00Z",
    });
    expect(
      shouldFailReachabilityImmediately("not_found", response),
    ).toBe(false);
  });

  test("defers only the first silent probe response", () => {
    expect(
      shouldDeferReachabilityOverlay({
        probeResponseCount: 1,
        silentGracePeriod: true,
      }),
    ).toBe(true);
    expect(
      shouldDeferReachabilityOverlay({
        probeResponseCount: 2,
        silentGracePeriod: true,
      }),
    ).toBe(false);
    expect(
      shouldDeferReachabilityOverlay({
        probeResponseCount: 1,
        silentGracePeriod: false,
      }),
    ).toBe(false);
  });
});
