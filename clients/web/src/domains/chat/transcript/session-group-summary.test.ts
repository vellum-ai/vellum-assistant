import { describe, expect, test } from "bun:test";

import {
  defaultSessionGroupOpen,
  describeSessionGroupSummary,
} from "./session-group-summary";

const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;

describe("describeSessionGroupSummary", () => {
  test.each(["working", "waiting", "finishing"] as const)(
    "uses injected time for the %s runtime state",
    (state) => {
      expect(
        describeSessionGroupSummary({
          state,
          startedAt: 10_000,
          lastActivityAt: 20_000,
          now: 75_900,
        }),
      ).toEqual({
        state,
        durationSeconds: 65,
        lastActivityAt: 20_000,
        endedAt: null,
      });
    },
  );

  test("uses a confirmed terminal end for a completed session", () => {
    expect(
      describeSessionGroupSummary({
        state: "completed",
        startedAt: 10_000,
        lastActivityAt: 60_000,
        endedAt: 70_000,
        now: 90_000,
      }),
    ).toEqual({
      state: "completed",
      durationSeconds: 60,
      lastActivityAt: 60_000,
      endedAt: 70_000,
    });
  });

  test("preserves an interrupted session's unknown end", () => {
    expect(
      describeSessionGroupSummary({
        state: "interrupted",
        startedAt: 10_000,
        lastActivityAt: 45_000,
        endedAt: null,
      }),
    ).toEqual({
      state: "interrupted",
      durationSeconds: 35,
      lastActivityAt: 45_000,
      endedAt: null,
    });
  });

  test("freezes a disconnected session at its last confirmed activity", () => {
    expect(
      describeSessionGroupSummary({
        state: "disconnected",
        startedAt: 10_000,
        lastActivityAt: 45_000,
        now: 90_000,
      }),
    ).toEqual({
      state: "disconnected",
      durationSeconds: 35,
      lastActivityAt: 45_000,
      endedAt: null,
    });
  });

  test("describes a settled segment without inventing terminal state", () => {
    expect(
      describeSessionGroupSummary({
        state: "settledSegment",
        startedAt: 10_000,
        endedAt: 25_500,
      }),
    ).toEqual({
      state: "settledSegment",
      durationSeconds: 15,
      lastActivityAt: null,
      endedAt: 25_500,
    });
  });

  test("returns unavailable timing for missing, invalid, or reversed bounds", () => {
    expect(
      describeSessionGroupSummary({
        state: "completed",
        startedAt: 20_000,
        endedAt: 10_000,
      }),
    ).toEqual({
      state: "completed",
      durationSeconds: null,
      lastActivityAt: null,
      endedAt: 10_000,
    });
    expect(
      describeSessionGroupSummary({
        state: "unavailable",
        startedAt: 10_000,
        endedAt: 20_000,
      }),
    ).toEqual({
      state: "unavailable",
      durationSeconds: null,
      lastActivityAt: null,
      endedAt: null,
    });
  });

  test("accepts the maximum JavaScript Date timestamp", () => {
    expect(
      describeSessionGroupSummary({
        state: "completed",
        startedAt: MAX_DATE_TIMESTAMP - 1_000,
        endedAt: MAX_DATE_TIMESTAMP,
      }),
    ).toEqual({
      state: "completed",
      durationSeconds: 1,
      lastActivityAt: null,
      endedAt: MAX_DATE_TIMESTAMP,
    });
  });

  test("rejects timestamps outside the JavaScript Date range", () => {
    expect(
      describeSessionGroupSummary({
        state: "completed",
        startedAt: 10_000,
        endedAt: MAX_DATE_TIMESTAMP + 1,
      }),
    ).toEqual({
      state: "completed",
      durationSeconds: null,
      lastActivityAt: null,
      endedAt: null,
    });
    expect(
      describeSessionGroupSummary({
        state: "interrupted",
        startedAt: 10_000,
        lastActivityAt: MAX_DATE_TIMESTAMP + 1,
      }),
    ).toEqual({
      state: "interrupted",
      durationSeconds: null,
      lastActivityAt: null,
      endedAt: null,
    });
  });
});

describe("defaultSessionGroupOpen", () => {
  test("opens live-observed groups and closes historical groups", () => {
    expect(defaultSessionGroupOpen(true)).toBe(true);
    expect(defaultSessionGroupOpen(false)).toBe(false);
  });
});
