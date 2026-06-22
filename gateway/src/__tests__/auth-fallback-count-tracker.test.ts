import { describe, expect, test } from "bun:test";

import { AuthFallbackCountTracker } from "../auth-fallback-count-tracker.js";

describe("AuthFallbackCountTracker", () => {
  test("increments per (guard, path, failureKind) key", () => {
    const t = new AuthFallbackCountTracker(0);
    t.increment("edge", "/v1/chat", "missing_authorization");
    t.increment("edge", "/v1/chat", "missing_authorization");
    t.increment("edge", "/v1/chat", "token_validation_failed");
    t.increment("edge-guardian", "/v1/chat", "missing_authorization");

    const snap = t.snapshot();
    expect(snap.length).toBe(3);
    const find = (g: string, p: string, f: string) =>
      snap.find((c) => c.guard === g && c.path === p && c.failureKind === f)
        ?.count;
    expect(find("edge", "/v1/chat", "missing_authorization")).toBe(2);
    expect(find("edge", "/v1/chat", "token_validation_failed")).toBe(1);
    expect(find("edge-guardian", "/v1/chat", "missing_authorization")).toBe(1);
  });

  test("drain returns the window + counts and resets", () => {
    const t = new AuthFallbackCountTracker(1000);
    t.increment("edge", "/v1/a", "missing_authorization");
    t.increment("edge", "/v1/a", "missing_authorization");

    const batch = t.drain(2000);
    expect(batch.windowStart).toBe(1000);
    expect(batch.windowEnd).toBe(2000);
    expect(batch.counts).toEqual([
      {
        guard: "edge",
        path: "/v1/a",
        failureKind: "missing_authorization",
        count: 2,
      },
    ]);

    // Drained — tracker is empty and the window is re-anchored to the drain.
    expect(t.snapshot()).toEqual([]);
    const empty = t.drain(3000);
    expect(empty.counts).toEqual([]);
    expect(empty.windowStart).toBe(2000);
    expect(empty.windowEnd).toBe(3000);
  });

  test("an empty drain leaves the window start anchored", () => {
    const t = new AuthFallbackCountTracker(1000);
    // Nothing recorded yet — draining must not shift windowStart forward.
    expect(t.drain(2000)).toMatchObject({ windowStart: 1000, windowEnd: 2000 });
    t.increment("edge", "/v1/a", "missing_authorization");
    expect(t.drain(3000).windowStart).toBe(1000);
  });

  test("merge folds a drained batch back in", () => {
    const t = new AuthFallbackCountTracker(0);
    t.increment("edge", "/v1/a", "missing_authorization");
    const batch = t.drain(100);

    // Simulate a failed flush: counts come back, plus a newer count for the
    // same key that accumulated after the drain.
    t.increment("edge", "/v1/a", "missing_authorization");
    t.merge(batch.counts);

    const snap = t.snapshot();
    expect(snap.length).toBe(1);
    expect(snap[0].count).toBe(2);
  });

  test("caps distinct keys but keeps counting existing ones", () => {
    const t = new AuthFallbackCountTracker(0);
    // MAX_TRACKED_KEYS is 10_000; exceed it with distinct paths.
    for (let i = 0; i < 10_050; i++) {
      t.increment("edge", `/v1/p${i}`, "missing_authorization");
    }
    const snap = t.snapshot();
    expect(snap.length).toBe(10_000);

    // An already-tracked key still increments past the cap.
    t.increment("edge", "/v1/p0", "missing_authorization");
    expect(t.snapshot().find((c) => c.path === "/v1/p0")?.count).toBe(2);
  });

  test("reset clears counts", () => {
    const t = new AuthFallbackCountTracker(0);
    t.increment("edge", "/v1/a", "missing_authorization");
    t.reset(500);
    expect(t.snapshot()).toEqual([]);
    expect(t.drain(600).windowStart).toBe(500);
  });
});
