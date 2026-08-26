import { describe, expect, test } from "bun:test";

import { ThreadParentCache } from "./thread-parents.js";
import "../__tests__/test-preload.js";

describe("ThreadParentCache", () => {
  test("resolves a thread to its parent channel", () => {
    const cache = new ThreadParentCache();
    cache.note({ id: "thread-1", type: 11, parent_id: "channel-1" });
    expect(cache.parentOf("thread-1")).toBe("channel-1");
  });

  test("ignores regular channels whose parent_id is a category", () => {
    // A type-0 channel's parent_id points at its category. Recording it would
    // misreport an ordinary channel message as belonging to a thread of its category.
    const cache = new ThreadParentCache();
    cache.note({ id: "channel-1", type: 0, parent_id: "category-1" });
    expect(cache.parentOf("channel-1")).toBeUndefined();
  });

  test("records every thread type", () => {
    const cache = new ThreadParentCache();
    cache.note({ id: "t-announcement", type: 10, parent_id: "c1" });
    cache.note({ id: "t-public", type: 11, parent_id: "c2" });
    cache.note({ id: "t-private", type: 12, parent_id: "c3" });
    expect(cache.parentOf("t-announcement")).toBe("c1");
    expect(cache.parentOf("t-public")).toBe("c2");
    expect(cache.parentOf("t-private")).toBe("c3");
  });

  test("ignores malformed channel objects", () => {
    const cache = new ThreadParentCache();
    cache.note({ id: "t1", type: 11, parent_id: null });
    cache.note({ id: "t2", type: 11 });
    cache.note({ type: 11, parent_id: "c1" });
    cache.note({ id: "t3", parent_id: "c1" });
    expect(cache.size).toBe(0);
  });

  test("noteAll seeds from a thread list and tolerates undefined", () => {
    const cache = new ThreadParentCache();
    cache.noteAll(undefined);
    cache.noteAll([
      { id: "t1", type: 11, parent_id: "c1" },
      { id: "t2", type: 12, parent_id: "c1" },
    ]);
    expect(cache.parentOf("t1")).toBe("c1");
    expect(cache.parentOf("t2")).toBe("c1");
  });

  test("forget removes a deleted thread", () => {
    const cache = new ThreadParentCache();
    cache.note({ id: "t1", type: 11, parent_id: "c1" });
    cache.forget("t1");
    expect(cache.parentOf("t1")).toBeUndefined();
    // Unknown ids are a no-op.
    cache.forget("never-seen");
    cache.forget(undefined);
  });

  test("an update supersedes the recorded parent", () => {
    const cache = new ThreadParentCache();
    cache.note({ id: "t1", type: 11, parent_id: "c1" });
    cache.note({ id: "t1", type: 11, parent_id: "c2" });
    expect(cache.parentOf("t1")).toBe("c2");
    expect(cache.size).toBe(1);
  });

  test("evicts the oldest entry past the cap", () => {
    const cache = new ThreadParentCache();
    for (let i = 0; i < 10_001; i++) {
      cache.note({ id: `t${i}`, type: 11, parent_id: "c" });
    }
    expect(cache.size).toBe(10_000);
    expect(cache.parentOf("t0")).toBeUndefined();
    expect(cache.parentOf("t10000")).toBe("c");
  });

  test("re-noting an existing thread refreshes its eviction position", () => {
    const cache = new ThreadParentCache();
    for (let i = 0; i < 10_000; i++) {
      cache.note({ id: `t${i}`, type: 11, parent_id: "c" });
    }
    // t0 is oldest; re-noting it should make t1 the eviction candidate.
    cache.note({ id: "t0", type: 11, parent_id: "c" });
    cache.note({ id: "fresh", type: 11, parent_id: "c" });
    expect(cache.parentOf("t0")).toBe("c");
    expect(cache.parentOf("t1")).toBeUndefined();
  });
});
