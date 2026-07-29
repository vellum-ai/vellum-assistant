import { describe, expect, test } from "bun:test";

import { ExponentialBackoff } from "./exponential-backoff.js";
import "../__tests__/test-preload.js";

describe("ExponentialBackoff", () => {
  test("grows exponentially from the base delay", () => {
    const backoff = new ExponentialBackoff({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitter: { mode: "additive", ratio: 0 },
    });
    expect(backoff.nextDelayMs()).toBe(1_000);
    expect(backoff.nextDelayMs()).toBe(2_000);
    expect(backoff.nextDelayMs()).toBe(4_000);
    expect(backoff.nextDelayMs()).toBe(8_000);
  });

  test("caps the window at maxDelayMs", () => {
    const backoff = new ExponentialBackoff({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitter: { mode: "additive", ratio: 0 },
    });
    for (let i = 0; i < 40; i++) {
      backoff.nextDelayMs();
    }
    expect(backoff.nextDelayMs()).toBe(30_000);
  });

  test("a per-call maxDelayMs overrides the constructor ceiling", () => {
    const backoff = new ExponentialBackoff({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitter: { mode: "additive", ratio: 0 },
    });
    for (let i = 0; i < 40; i++) {
      backoff.nextDelayMs();
    }
    expect(backoff.nextDelayMs({ maxDelayMs: 600_000 })).toBe(600_000);
    expect(backoff.nextDelayMs()).toBe(30_000);
  });

  test("additive jitter floors the delay at the window", () => {
    const atZero = new ExponentialBackoff({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitter: { mode: "additive", ratio: 0.5 },
      random: () => 0,
    });
    expect(atZero.nextDelayMs()).toBe(1_000);

    const atOne = new ExponentialBackoff({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitter: { mode: "additive", ratio: 0.5 },
      random: () => 1,
    });
    expect(atOne.nextDelayMs()).toBe(1_500);
  });

  test("full jitter spreads the delay over the whole window", () => {
    const atZero = new ExponentialBackoff({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitter: { mode: "full" },
      random: () => 0,
    });
    expect(atZero.nextDelayMs()).toBe(0);

    const atHalf = new ExponentialBackoff({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitter: { mode: "full" },
      random: () => 0.5,
    });
    expect(atHalf.nextDelayMs()).toBe(500);
  });

  test("reset returns the window to the base delay", () => {
    const backoff = new ExponentialBackoff({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitter: { mode: "additive", ratio: 0 },
    });
    backoff.nextDelayMs();
    backoff.nextDelayMs();
    expect(backoff.attemptCount).toBe(2);

    backoff.reset();
    expect(backoff.attemptCount).toBe(0);
    expect(backoff.nextDelayMs()).toBe(1_000);
  });

  test("attemptCount reflects the attempts drawn, not resets alone", () => {
    const backoff = new ExponentialBackoff({
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitter: { mode: "full" },
      random: () => 1,
    });
    expect(backoff.attemptCount).toBe(0);
    backoff.nextDelayMs();
    expect(backoff.attemptCount).toBe(1);
    backoff.nextDelayMs({ maxDelayMs: 10_000 });
    expect(backoff.attemptCount).toBe(2);
  });

  test("rounds the delay to whole milliseconds", () => {
    const backoff = new ExponentialBackoff({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitter: { mode: "additive", ratio: 0.5 },
      random: () => 0.333,
    });
    expect(backoff.nextDelayMs()).toBe(Math.round(1_000 + 0.5 * 0.333 * 1_000));
  });
});
