import { describe, expect, test } from "bun:test";

import {
  computeRetryDelayMs,
  isRetryableStatus,
  MAX_TIMER_DELAY_MS,
} from "./retry-policy.js";

describe("isRetryableStatus", () => {
  test("retries rate limits and server faults", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });

  test("does not retry a request the server rejected on its merits", () => {
    // A retry reproduces these exactly, so repeating them only burns quota.
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  test("does not retry success", () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(204)).toBe(false);
  });
});

describe("computeRetryDelayMs", () => {
  test("honours a Retry-After given in seconds", () => {
    expect(computeRetryDelayMs(1, 1000, "3")).toBe(3000);
    // Discord sends fractional seconds.
    expect(computeRetryDelayMs(1, 1000, "0.75")).toBe(750);
  });

  test("honours a Retry-After given as an HTTP date", () => {
    const target = new Date(Date.now() + 5000).toUTCString();
    const delay = computeRetryDelayMs(1, 1000, target);
    // Whole-second date resolution, so allow the truncation either way.
    expect(delay).toBeGreaterThan(3000);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  test("caps a server-advertised wait at the caller's bound", () => {
    // A caller holding a lock across the wait passes a small bound so a long
    // rate-limit window fails the call instead of stalling behind it.
    expect(computeRetryDelayMs(1, 1000, "3600", 60_000)).toBe(60_000);
  });

  test("caps at the timer ceiling by default, so the wait is real", () => {
    // Past this setTimeout fires immediately, turning a long wait into none.
    expect(computeRetryDelayMs(1, 1000, "999999999")).toBe(MAX_TIMER_DELAY_MS);
  });

  test("backs off exponentially when the server gives no hint", () => {
    for (const [attempt, base] of [
      [1, 1000],
      [2, 2000],
      [3, 4000],
    ] as const) {
      const delay = computeRetryDelayMs(attempt, 1000, null);
      expect(delay).toBeGreaterThanOrEqual(base);
      // Jitter is additive and bounded at half the exponential term.
      expect(delay).toBeLessThanOrEqual(base * 1.5);
    }
  });

  test("jitters, so callers that failed together do not resume together", () => {
    const delays = new Set(
      Array.from({ length: 20 }, () => computeRetryDelayMs(3, 1000, null)),
    );
    expect(delays.size).toBeGreaterThan(1);
  });

  test("falls back to backoff for unusable Retry-After values", () => {
    for (const value of ["", "soon", "-5", "0"]) {
      const delay = computeRetryDelayMs(1, 1000, value);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1500);
    }
  });

  test("ignores an already-elapsed Retry-After date", () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    const delay = computeRetryDelayMs(1, 1000, past);
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(1500);
  });
});
