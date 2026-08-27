import { describe, expect, test } from "bun:test";

import { createGenerationGuard } from "./generation-guard";

describe("createGenerationGuard", () => {
  test("an untouched key validates its own snapshot", () => {
    const guard = createGenerationGuard();
    const snapshot = guard.current("a");
    expect(snapshot).toBe(0);
    expect(guard.isCurrent("a", snapshot)).toBe(true);
  });

  test("a claim supersedes an earlier snapshot", () => {
    const guard = createGenerationGuard();
    const snapshot = guard.current("a");
    guard.claim("a");
    expect(guard.isCurrent("a", snapshot)).toBe(false);
    expect(guard.isCurrent("a", guard.current("a"))).toBe(true);
  });

  test("invalidate supersedes in-flight claims without a new one", () => {
    const guard = createGenerationGuard();
    const generation = guard.claim("a");
    guard.invalidate("a");
    expect(guard.isCurrent("a", generation)).toBe(false);
  });
});
