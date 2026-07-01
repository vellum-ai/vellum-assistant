import { describe, expect, test } from "bun:test";

import {
  reportSlowSync,
  SLOW_SYNC_CHECK_NAME,
  SLOW_SYNC_THRESHOLD_MS,
  timeSyncSection,
} from "../slow-sync-log.js";

describe("slow-sync-log", () => {
  test("threshold default is a positive number", () => {
    expect(SLOW_SYNC_THRESHOLD_MS).toBeGreaterThan(0);
    expect(SLOW_SYNC_CHECK_NAME).toBe("slow_sync_operation");
  });

  test("timeSyncSection returns the section's value and runs it once", () => {
    let calls = 0;
    const result = timeSyncSection("test:value", () => {
      calls++;
      return 42;
    });
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  test("timeSyncSection propagates a thrown error unchanged", () => {
    const boom = new Error("boom");
    expect(() =>
      timeSyncSection("test:throw", () => {
        throw boom;
      }),
    ).toThrow(boom);
  });

  test("timeSyncSection only evaluates the detail thunk when reporting", () => {
    // A fast section stays below the threshold, so the detail thunk (which
    // would allocate on a hot query path) must not run.
    let detailCalls = 0;
    timeSyncSection(
      "test:detail",
      () => [1, 2, 3],
      () => {
        detailCalls++;
        return { evaluated: true };
      },
    );
    expect(detailCalls).toBe(0);
  });

  test("reportSlowSync is a no-op below the threshold and does not throw above it", () => {
    // Below threshold: silent no-op.
    expect(() => reportSlowSync("test:fast", 0)).not.toThrow();
    expect(() =>
      reportSlowSync("test:fast", SLOW_SYNC_THRESHOLD_MS - 1),
    ).not.toThrow();
    // At/above threshold: logs + records telemetry (telemetry no-ops under the
    // test opt-out); must never throw out of the timed section.
    expect(() =>
      reportSlowSync("test:slow", SLOW_SYNC_THRESHOLD_MS + 5000, {
        conversationId: "conv-123",
        rowCount: 4200,
      }),
    ).not.toThrow();
  });
});
