import { describe, expect, test } from "bun:test";

import {
  computeRetryDelay,
  DEFAULT_MAX_BACKOFF_MS,
} from "../schedule/retry-backoff.js";
import { decideRetry } from "../schedule/retry-policy.js";

describe("computeRetryDelay", () => {
  const noJitter = () => 0.5;
  const maxJitter = () => 1.0;
  const minJitter = () => 0.0;

  test("returns exact baseMs with no jitter for attempt 0", () => {
    expect(computeRetryDelay(0, 60_000, undefined, noJitter)).toBe(60_000);
  });

  test("doubles for each subsequent attempt", () => {
    expect(computeRetryDelay(0, 1000, undefined, noJitter)).toBe(1000);
    expect(computeRetryDelay(1, 1000, undefined, noJitter)).toBe(2000);
    expect(computeRetryDelay(2, 1000, undefined, noJitter)).toBe(4000);
    expect(computeRetryDelay(3, 1000, undefined, noJitter)).toBe(8000);
  });

  test("applies +20% jitter at max", () => {
    expect(computeRetryDelay(0, 10_000, undefined, maxJitter)).toBe(12_000);
  });

  test("applies -20% jitter at min", () => {
    expect(computeRetryDelay(0, 10_000, undefined, minJitter)).toBe(8_000);
  });

  test("caps at maxMs AFTER jitter (never exceeds cap)", () => {
    expect(computeRetryDelay(20, 60_000, 300_000, maxJitter)).toBe(300_000);
    expect(computeRetryDelay(20, 60_000, 300_000, noJitter)).toBe(300_000);
  });

  test("caps at DEFAULT_MAX_BACKOFF_MS when maxMs not specified", () => {
    const d = computeRetryDelay(100, 60_000, undefined, maxJitter);
    expect(d).toBeLessThanOrEqual(DEFAULT_MAX_BACKOFF_MS);
  });

  test("never returns negative", () => {
    expect(
      computeRetryDelay(0, 1, undefined, minJitter),
    ).toBeGreaterThanOrEqual(0);
    expect(computeRetryDelay(0, 0, undefined, minJitter)).toBe(0);
  });
});

describe("decideRetry", () => {
  const baseJob = {
    id: "job-1",
    name: "Test",
    maxRetries: 3,
    retryBackoffMs: 60_000,
  };
  const now = 1_000_000;

  test("retries when retryCount < maxRetries", () => {
    const d = decideRetry({ ...baseJob, retryCount: 0 }, now);
    expect(d.action).toBe("retry");
    if (d.action === "retry") {
      expect(d.nextRetryAt).toBeGreaterThan(now);
    }
  });

  test("retries on last allowed attempt (retryCount = maxRetries - 1)", () => {
    const d = decideRetry({ ...baseJob, retryCount: 2 }, now);
    expect(d.action).toBe("retry");
  });

  test("exhausts when retryCount >= maxRetries", () => {
    expect(decideRetry({ ...baseJob, retryCount: 3 }, now).action).toBe(
      "exhaust",
    );
    expect(decideRetry({ ...baseJob, retryCount: 5 }, now).action).toBe(
      "exhaust",
    );
  });

  test("maxRetries=0 means no retries", () => {
    expect(
      decideRetry({ ...baseJob, maxRetries: 0, retryCount: 0 }, now).action,
    ).toBe("exhaust");
  });
});
