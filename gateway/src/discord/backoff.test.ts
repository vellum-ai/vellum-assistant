import { describe, expect, test } from "bun:test";

import { ReconnectBackoff, SESSION_STABLE_AFTER_MS } from "./backoff.js";
import "../__tests__/test-preload.js";

/** Jitter pinned to the top of the window, so delays read as the raw cap. */
const maxJitter = () => 1;

describe("ReconnectBackoff", () => {
  test("grows exponentially from one second", () => {
    const backoff = new ReconnectBackoff(maxJitter);
    expect(backoff.nextDelayMs("resume")).toBe(1_000);
    expect(backoff.nextDelayMs("resume")).toBe(2_000);
    expect(backoff.nextDelayMs("resume")).toBe(4_000);
    expect(backoff.nextDelayMs("resume")).toBe(8_000);
  });

  test("caps resumes at 30s and identifies at 10 minutes", () => {
    const backoff = new ReconnectBackoff(maxJitter);
    for (let i = 0; i < 40; i++) {
      backoff.nextDelayMs("resume");
    }
    expect(backoff.nextDelayMs("resume")).toBe(30_000);
    expect(backoff.nextDelayMs("identify")).toBe(600_000);
  });

  test("a sustained identify loop stays inside the 1000/24h budget", () => {
    // The assertion this module exists for. Breaching the cap resets the bot
    // token, so the ceiling is derived from the budget rather than chosen for
    // recovery feel — and a ceiling that looks conservative can still fail it
    // (a 120s cap yields ~1440/day).
    const backoff = new ReconnectBackoff(maxJitter);
    for (let i = 0; i < 40; i++) {
      backoff.nextDelayMs("identify");
    }

    // Full jitter draws uniformly over [0, cap), so the mean delay is cap/2.
    const capMs = backoff.nextDelayMs("identify");
    const meanDelayMs = capMs / 2;
    const identifiesPerDay = (24 * 60 * 60 * 1_000) / meanDelayMs;

    expect(identifiesPerDay).toBeLessThan(1_000);
  });

  test("uses full jitter — a delay may be anywhere in the window", () => {
    // Additive jitter (Slack's approach) would floor every delay at the
    // window; full jitter spreads retries so instances recovering from one
    // Discord-side outage do not resynchronise.
    const zeroJitter = new ReconnectBackoff(() => 0);
    expect(zeroJitter.nextDelayMs("resume")).toBe(0);

    const halfJitter = new ReconnectBackoff(() => 0.5);
    expect(halfJitter.nextDelayMs("resume")).toBe(500);
  });

  test("does not reset until a session proves stable", () => {
    // The credential-safety property. Slack resets its counter when the socket
    // opens; doing that here would let a socket that opens and dies reset the
    // delay every cycle, turning an outage into a tight identify loop.
    const backoff = new ReconnectBackoff(maxJitter);
    backoff.nextDelayMs("identify");
    backoff.nextDelayMs("identify");
    expect(backoff.failureCount).toBe(2);

    // Attempting a connection — even reaching a new socket — changes nothing.
    expect(backoff.nextDelayMs("identify")).toBe(4_000);
    expect(backoff.failureCount).toBe(3);

    backoff.noteSessionStable();
    expect(backoff.failureCount).toBe(0);
    expect(backoff.nextDelayMs("identify")).toBe(1_000);
  });

  test("carries resume failures into the next identify", () => {
    // Repeated resume failures are the same instability signal. Letting the
    // first identify after them start from zero is how a flap reaches the
    // budget-spending path at full speed.
    const backoff = new ReconnectBackoff(maxJitter);
    backoff.nextDelayMs("resume");
    backoff.nextDelayMs("resume");
    backoff.nextDelayMs("resume");
    expect(backoff.nextDelayMs("identify")).toBe(8_000);
  });

  test("requires a session to outlive a brief flap before counting as stable", () => {
    // Two minutes is long enough that a session dying on arrival — the exact
    // failure this pacing survives — cannot be mistaken for success.
    expect(SESSION_STABLE_AFTER_MS).toBeGreaterThanOrEqual(60_000);
  });
});
