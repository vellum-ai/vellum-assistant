import { describe, expect, test } from "bun:test";

import {
  computeNextEligibleRunAt,
  type NextEligibleInput,
} from "../next-eligible-run.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_START = Date.UTC(2026, 0, 1, 0, 0, 0); // a known midnight baseline

/** Resolve the local hour as UTC-hours offset from DAY_START — deterministic. */
function utcHourFor(ms: number): number {
  return new Date(ms).getUTCHours();
}

function baseInput(
  overrides: Partial<NextEligibleInput> = {},
): NextEligibleInput {
  return {
    from: DAY_START + 9 * HOUR_MS, // 09:00
    intervalMs: HOUR_MS,
    activeHoursStart: null,
    activeHoursEnd: null,
    timezone: null,
    dailyCapReached: false,
    getHourFor: utcHourFor,
    ...overrides,
  };
}

describe("computeNextEligibleRunAt", () => {
  test("plain interval advance inside active hours", () => {
    const from = DAY_START + 9 * HOUR_MS; // 09:00
    const result = computeNextEligibleRunAt(
      baseInput({
        from,
        activeHoursStart: 8,
        activeHoursEnd: 18,
      }),
    );
    // 10:00 is inside [8,18) — naive next interval is eligible.
    expect(result).toBe(from + HOUR_MS);
  });

  test("no active-hours window returns from + intervalMs", () => {
    const from = DAY_START + 3 * HOUR_MS;
    const result = computeNextEligibleRunAt(baseInput({ from }));
    expect(result).toBe(from + HOUR_MS);
  });

  test("jumps to next morning when interval lands after activeHoursEnd", () => {
    const from = DAY_START + 17 * HOUR_MS; // 17:00
    const result = computeNextEligibleRunAt(
      baseInput({
        from,
        activeHoursStart: 8,
        activeHoursEnd: 18,
      }),
    );
    // 18:00 is outside [8,18); next opening is 08:00 the following day.
    expect(utcHourFor(result)).toBe(8);
    expect(result).toBe(DAY_START + (24 + 8) * HOUR_MS);
    expect(result).toBeGreaterThan(from);
  });

  test("overnight window (22 -> 6) keeps late-night hours eligible", () => {
    const from = DAY_START + 23 * HOUR_MS; // 23:00
    const result = computeNextEligibleRunAt(
      baseInput({
        from,
        activeHoursStart: 22,
        activeHoursEnd: 6,
      }),
    );
    // 00:00 next day is inside the overnight window 22..6.
    expect(result).toBe(from + HOUR_MS);
    expect(utcHourFor(result)).toBe(0);
  });

  test("overnight window skips the daytime gap to next opening", () => {
    const from = DAY_START + 9 * HOUR_MS; // 09:00
    const result = computeNextEligibleRunAt(
      baseInput({
        from,
        activeHoursStart: 22,
        activeHoursEnd: 6,
      }),
    );
    // 10:00 is outside 22..6; next opening is 22:00 same day.
    expect(utcHourFor(result)).toBe(22);
    expect(result).toBe(DAY_START + 22 * HOUR_MS);
  });

  test("daily-cap-reached jumps to next local midnight when no window", () => {
    const from = DAY_START + 14 * HOUR_MS; // 14:00
    const result = computeNextEligibleRunAt(
      baseInput({
        from,
        dailyCapReached: true,
      }),
    );
    // Cap resets at local midnight — next day's 00:00.
    expect(utcHourFor(result)).toBe(0);
    expect(result).toBe(DAY_START + 24 * HOUR_MS);
  });

  test("daily-cap-reached jumps to next day's active-hours opening", () => {
    const from = DAY_START + 14 * HOUR_MS; // 14:00
    const result = computeNextEligibleRunAt(
      baseInput({
        from,
        activeHoursStart: 8,
        activeHoursEnd: 18,
        dailyCapReached: true,
      }),
    );
    // Cap resets at midnight, then the window nudges to 08:00.
    expect(utcHourFor(result)).toBe(8);
    expect(result).toBe(DAY_START + (24 + 8) * HOUR_MS);
  });

  test("timezone-driven hour extraction via injected getHourFor", () => {
    const from = DAY_START + 17 * HOUR_MS;
    // A resolver that reports every step as inside the window proves the
    // injected hour source — not wall-clock — drives the decision.
    const result = computeNextEligibleRunAt(
      baseInput({
        from,
        activeHoursStart: 8,
        activeHoursEnd: 18,
        timezone: "America/New_York",
        getHourFor: () => 10, // always "10:00", always inside [8,18)
      }),
    );
    expect(result).toBe(from + HOUR_MS);
  });

  test("never returns a value <= from", () => {
    const from = DAY_START + 5 * HOUR_MS;
    const result = computeNextEligibleRunAt(
      baseInput({
        from,
        intervalMs: HOUR_MS,
        activeHoursStart: 8,
        activeHoursEnd: 18,
      }),
    );
    expect(result).toBeGreaterThan(from);
  });
});
