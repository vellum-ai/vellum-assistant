import { describe, test, expect, beforeEach } from "bun:test";
import { DedupCache } from "../dedup-cache.js";

describe("DedupCache", () => {
  let cache: DedupCache;

  beforeEach(() => {
    cache = new DedupCache(5_000, 100);
  });

  test("returns undefined for unseen update_id", () => {
    expect(cache.get(123)).toBeUndefined();
  });

  test("returns cached entry after set", () => {
    cache.set(100, '{"ok":true}', 200);
    const hit = cache.get(100);
    expect(hit).toEqual({ body: '{"ok":true}', status: 200 });
  });

  test("different update_ids are independent", () => {
    cache.set(1, '{"a":1}', 200);
    cache.set(2, '{"a":2}', 201);
    expect(cache.get(1)?.body).toBe('{"a":1}');
    expect(cache.get(2)?.body).toBe('{"a":2}');
    expect(cache.get(3)).toBeUndefined();
  });

  test("expired entries are not returned", () => {
    // Use a 1ms TTL so entries expire immediately
    const shortCache = new DedupCache(1, 100);
    shortCache.set(42, '{"ok":true}', 200);

    // Wait for the entry to expire
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait
    }

    expect(shortCache.get(42)).toBeUndefined();
  });

  test("evicts oldest entry when at max capacity", () => {
    const tinyCache = new DedupCache(60_000, 3);
    tinyCache.set(1, "a", 200);
    tinyCache.set(2, "b", 200);
    tinyCache.set(3, "c", 200);
    expect(tinyCache.size).toBe(3);

    // Adding a 4th should evict the oldest (1)
    tinyCache.set(4, "d", 200);
    expect(tinyCache.size).toBe(3);
    expect(tinyCache.get(1)).toBeUndefined();
    expect(tinyCache.get(4)?.body).toBe("d");
  });

  test("size reflects current entries", () => {
    expect(cache.size).toBe(0);
    cache.set(1, "x", 200);
    expect(cache.size).toBe(1);
    cache.set(2, "y", 200);
    expect(cache.size).toBe(2);
  });
});
