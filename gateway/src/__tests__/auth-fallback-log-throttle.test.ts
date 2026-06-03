import { describe, expect, test } from "bun:test";

import { AuthFallbackLogThrottle } from "../auth-fallback-log-throttle.js";

describe("AuthFallbackLogThrottle", () => {
  test("logs the first time a key is seen", () => {
    const throttle = new AuthFallbackLogThrottle();
    expect(throttle.shouldLog("edge /v1/chat", 0)).toBe(true);
  });

  test("suppresses repeats within the cooldown window", () => {
    const throttle = new AuthFallbackLogThrottle(1000);
    expect(throttle.shouldLog("edge /v1/chat", 0)).toBe(true);
    expect(throttle.shouldLog("edge /v1/chat", 500)).toBe(false);
    expect(throttle.shouldLog("edge /v1/chat", 999)).toBe(false);
  });

  test("logs again once the cooldown elapses", () => {
    const throttle = new AuthFallbackLogThrottle(1000);
    expect(throttle.shouldLog("edge /v1/chat", 0)).toBe(true);
    // now - last === cooldownMs is not < cooldownMs, so it logs again.
    expect(throttle.shouldLog("edge /v1/chat", 1000)).toBe(true);
    expect(throttle.shouldLog("edge /v1/chat", 1500)).toBe(false);
  });

  test("tracks distinct endpoints independently", () => {
    const throttle = new AuthFallbackLogThrottle(1000);
    expect(throttle.shouldLog("edge /v1/chat", 0)).toBe(true);
    expect(throttle.shouldLog("edge-guardian /v1/guardian/sync", 0)).toBe(true);
    // Each key has its own window — neither suppresses the other.
    expect(throttle.shouldLog("edge /v1/chat", 100)).toBe(false);
    expect(throttle.shouldLog("edge-guardian /v1/guardian/sync", 100)).toBe(
      false,
    );
  });
});
