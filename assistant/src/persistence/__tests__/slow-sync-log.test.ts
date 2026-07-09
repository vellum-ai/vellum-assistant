import { beforeEach, describe, expect, test } from "bun:test";

import {
  endSection,
  getSectionTrail,
  markSection,
  reportSlowSync,
  resetSectionTrailForTests,
  SLOW_SYNC_CHECK_NAME,
  SLOW_SYNC_THRESHOLD_MS,
  timeSyncSection,
  traceAsyncSection,
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

describe("section trail", () => {
  beforeEach(() => {
    resetSectionTrailForTests();
  });

  test("marks appear newest-first with ago values relative to now", () => {
    const first = markSection("test:first");
    endSection(first);
    markSection("test:second");

    const trail = getSectionTrail(performance.now() + 100);
    expect(trail.map((e) => e.label)).toEqual(["test:second", "test:first"]);
    // Both marks started before the reference "now".
    for (const entry of trail) {
      expect(entry.startedAgoMs).toBeGreaterThanOrEqual(100);
    }
    // Only the ended mark carries an end age.
    expect(trail[0]?.endedAgoMs).toBeUndefined();
    expect(trail[1]?.endedAgoMs).toBeGreaterThanOrEqual(100);
  });

  test("endSection returns the section's elapsed time", () => {
    const mark = markSection("test:elapsed");
    const elapsed = endSection(mark);
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(mark.endedAt).toBeDefined();
  });

  test("trail is capacity-bounded, evicting oldest marks", () => {
    for (let i = 0; i < 20; i++) {
      endSection(markSection(`test:mark-${i}`));
    }
    const trail = getSectionTrail();
    expect(trail.length).toBe(16);
    // Newest-first: the most recent mark leads, the earliest four are evicted.
    expect(trail[0]?.label).toBe("test:mark-19");
    expect(trail[trail.length - 1]?.label).toBe("test:mark-4");
  });

  test("timeSyncSection leaves an ended mark in the trail", () => {
    timeSyncSection("test:timed", () => 1);
    const trail = getSectionTrail();
    expect(trail[0]?.label).toBe("test:timed");
    expect(trail[0]?.endedAgoMs).toBeDefined();
  });

  test("timeSyncSection ends its mark when the section throws", () => {
    expect(() =>
      timeSyncSection("test:timed-throw", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const trail = getSectionTrail();
    expect(trail[0]?.label).toBe("test:timed-throw");
    expect(trail[0]?.endedAgoMs).toBeDefined();
  });

  test("traceAsyncSection returns the value and ends the mark across an await", async () => {
    const result = await traceAsyncSection("test:async", async () => {
      // While awaited, the mark is open.
      expect(getSectionTrail()[0]?.label).toBe("test:async");
      expect(getSectionTrail()[0]?.endedAgoMs).toBeUndefined();
      await Promise.resolve();
      return "ok";
    });
    expect(result).toBe("ok");
    const trail = getSectionTrail();
    expect(trail[0]?.label).toBe("test:async");
    expect(trail[0]?.endedAgoMs).toBeDefined();
  });

  test("traceAsyncSection ends the mark when the span rejects", async () => {
    let thrown: unknown;
    try {
      await traceAsyncSection("test:async-throw", async () => {
        throw new Error("boom");
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(getSectionTrail()[0]?.endedAgoMs).toBeDefined();
  });
});
