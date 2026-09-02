/**
 * Pins the failure semantics the lazy KaTeX loader depends on: a rejection
 * is not cached (the next load retries), a resolution is cached (no reload),
 * and concurrent callers share one flight.
 */
import { describe, expect, test } from "bun:test";

import { asyncOnce } from "./async-once";

function countingLoader(failures: number) {
  let remaining = failures;
  let calls = 0;
  const once = asyncOnce(async () => {
    calls += 1;
    if (remaining > 0) {
      remaining -= 1;
      throw new Error("load failed");
    }
    return "loaded";
  });
  return { once, calls: () => calls };
}

describe("asyncOnce", () => {
  test("a rejection clears the slot so the next load retries", async () => {
    const { once, calls } = countingLoader(1);

    expect(once.peek()).toBeNull();
    await expect(once.load()).rejects.toThrow("load failed");
    expect(once.peek()).toBeNull();

    await expect(once.load()).resolves.toBe("loaded");
    expect(once.peek()).toBe("loaded");
    expect(calls()).toBe(2);
  });

  test("a resolution is cached: later loads reuse it without reloading", async () => {
    const { once, calls } = countingLoader(0);

    await once.load();
    await once.load();

    expect(calls()).toBe(1);
    expect(once.peek()).toBe("loaded");
  });

  test("concurrent callers share one flight, on failure too", async () => {
    const { once, calls } = countingLoader(1);

    const results = await Promise.allSettled([once.load(), once.load()]);

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(calls()).toBe(1);

    await expect(once.load()).resolves.toBe("loaded");
    expect(calls()).toBe(2);
  });
});
