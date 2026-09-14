import { describe, expect, test } from "bun:test";

import {
  BARGE_IN_GAP_TOLERANCE_MS,
  BARGE_IN_MAX_TOLERATED_SILENCE_RATIO,
  createBargeInGuard,
} from "../barge-in-guard.js";

describe("createBargeInGuard", () => {
  test("speech shorter than the threshold stays pending", () => {
    const guard = createBargeInGuard(250);
    expect(guard.track("speech", 100)).toBe("pending");
    expect(guard.track("speech", 100)).toBe("pending");
    expect(guard.speechMs).toBe(200);
  });

  test("sustained speech reaching the threshold fires once and stays fired", () => {
    const guard = createBargeInGuard(250);
    guard.track("speech", 200);
    expect(guard.track("speech", 50)).toBe("fired");
    expect(guard.track("silence", 1_000)).toBe("fired");
  });

  test("a brief sub-threshold gap does not reset the run", () => {
    const guard = createBargeInGuard(250);
    guard.track("speech", 150);
    expect(guard.track("silence", 100)).toBe("pending");
    expect(guard.speechMs).toBe(150);
    expect(guard.track("speech", 100)).toBe("fired");
  });

  test("a gap of exactly the tolerance is still inside the run", () => {
    const guard = createBargeInGuard(250);
    guard.track("speech", 150);
    expect(guard.track("silence", BARGE_IN_GAP_TOLERANCE_MS)).toBe("pending");
    expect(guard.speechMs).toBe(150);
  });

  test("a gap longer than the tolerance resets the run", () => {
    const guard = createBargeInGuard(250);
    guard.track("speech", 150);
    guard.track("silence", 150);
    expect(guard.track("silence", 100)).toBe("reset");
    expect(guard.speechMs).toBe(0);
    expect(guard.track("speech", 200)).toBe("pending");
  });

  test("sparse periodic blips separated by boundary gaps never accumulate", () => {
    const guard = createBargeInGuard(250);
    // 10 ms blips every 200 ms: each gap is tolerated on its own, but the
    // run's total silence outweighs the speech by the duty-cycle ceiling.
    const cap = 250 * BARGE_IN_MAX_TOLERATED_SILENCE_RATIO;
    let steps = 0;
    let sawReset = false;
    while (steps < 60) {
      guard.track("speech", 10);
      if (guard.track("silence", 200) === "reset") {
        sawReset = true;
        break;
      }
      steps += 1;
    }
    expect(sawReset).toBe(true);
    expect(steps * 200).toBeLessThanOrEqual(cap + 200);
    expect(guard.speechMs).toBe(0);
  });

  test("classified echo resets a partial run immediately", () => {
    const guard = createBargeInGuard(250);
    guard.track("speech", 200);
    expect(guard.track("echo", 10)).toBe("reset");
    expect(guard.speechMs).toBe(0);
  });

  test("a zero threshold fires on the first speech chunk", () => {
    const guard = createBargeInGuard(0);
    // With no speech required, any silence already outweighs it.
    expect(guard.track("silence", 20)).toBe("reset");
    expect(guard.track("speech", 20)).toBe("fired");
  });
});
