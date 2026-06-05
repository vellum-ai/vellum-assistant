import { describe, expect, test } from "bun:test";

import { WorkingSetEntry } from "../types.js";
import { ScoreFn, WorkingSet } from "../working-set.js";

describe("WorkingSet.evict", () => {
  test("evicts a page unseen past the window", () => {
    const ws = new WorkingSet(150, 5);
    ws.recordSelection("alpha", 0, false);

    // currentTurn 6, lastSeen 0 → gap 6 > window 5 → evict.
    ws.evict(6, new Set());

    expect(ws.union().has("alpha")).toBe(false);
    expect(ws.size()).toBe(0);
  });

  test("keeps a page still inside the window", () => {
    const ws = new WorkingSet(150, 5);
    ws.recordSelection("alpha", 0, false);

    // gap 5 is not > 5 → keep.
    ws.evict(5, new Set());

    expect(ws.union().has("alpha")).toBe(true);
  });

  test("pinned page never evicts past the window", () => {
    const ws = new WorkingSet(150, 5);
    ws.recordSelection("alpha", 0, true);

    ws.evict(100, new Set());

    expect(ws.union().has("alpha")).toBe(true);
  });

  test("exceeding maxPages evicts the least-recently-selected non-pinned page first", () => {
    const ws = new WorkingSet(2, 1000);
    ws.recordSelection("oldest", 1, false);
    ws.recordSelection("middle", 2, false);
    ws.recordSelection("newest", 3, false);

    // No window eviction (window huge); cap is 2 → drop lowest lastSeenTurn.
    ws.evict(3, new Set());

    expect(ws.size()).toBe(2);
    expect(ws.union().has("oldest")).toBe(false);
    expect(ws.union().has("middle")).toBe(true);
    expect(ws.union().has("newest")).toBe(true);
  });

  test("cap eviction never drops pinned pages even when over capacity", () => {
    const ws = new WorkingSet(1, 1000);
    ws.recordSelection("pinned-a", 1, true);
    ws.recordSelection("pinned-b", 2, true);
    ws.recordSelection("loose", 3, false);

    ws.evict(3, new Set());

    // Only the non-pinned page can go; pinned pages stay even over cap.
    expect(ws.union().has("pinned-a")).toBe(true);
    expect(ws.union().has("pinned-b")).toBe(true);
    expect(ws.union().has("loose")).toBe(false);
    expect(ws.size()).toBe(2);
  });

  test("core slugs passed to evict are dropped if present", () => {
    const ws = new WorkingSet(150, 5);
    ws.recordSelection("alpha", 5, false);
    ws.recordSelection("beta", 5, true); // pinned, but core still wins
    ws.recordSelection("gamma", 5, false);

    ws.evict(5, new Set(["alpha", "beta"]));

    expect(ws.union().has("alpha")).toBe(false);
    expect(ws.union().has("beta")).toBe(false);
    expect(ws.union().has("gamma")).toBe(true);
  });

  test("custom scoreFn reorders cap-evictions", () => {
    // Score by selectedAtTurn instead of lastSeenTurn: the page selected
    // earliest becomes most evictable regardless of recent activity.
    const bySelectedAt: ScoreFn = (e: WorkingSetEntry) => e.selectedAtTurn;
    const ws = new WorkingSet(2, 1000, bySelectedAt);

    ws.recordSelection("first", 0, false);
    ws.recordSelection("second", 1, false);
    ws.recordSelection("third", 2, false);
    // Bump "first" so plain LRU would protect it, but selectedAt still lowest.
    ws.recordSelection("first", 9, false);

    ws.evict(9, new Set());

    expect(ws.size()).toBe(2);
    // Under custom score, "first" (selectedAt 0) evicts despite recent touch.
    expect(ws.union().has("first")).toBe(false);
    expect(ws.union().has("second")).toBe(true);
    expect(ws.union().has("third")).toBe(true);
  });

  test("default no-arg constructor still works for existing callers", () => {
    const ws = new WorkingSet();
    ws.recordSelection("alpha", 0, false);
    expect(ws.size()).toBe(1);
  });
});
