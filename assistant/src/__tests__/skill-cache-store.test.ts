import { afterEach, describe, expect, test } from "bun:test";

import {
  _internals,
  clearCacheForTests,
  deleteCacheEntry,
  getCacheEntry,
  setCacheEntry,
} from "../skills/skill-cache-store.js";

afterEach(() => {
  clearCacheForTests();
});

describe("setCacheEntry", () => {
  test("auto-generated key is a 16-char lowercase hex string", () => {
    const { key } = setCacheEntry("hello");
    expect(key).toHaveLength(16);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  test("each auto-generated key is unique", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 20; i++) {
      keys.add(setCacheEntry(i).key);
    }
    expect(keys.size).toBe(20);
  });

  test("explicit key stores and retrieves correctly", () => {
    setCacheEntry({ foo: "bar" }, { key: "my-key" });
    const result = getCacheEntry("my-key");
    expect(result).toEqual({ data: { foo: "bar" } });
  });

  test("explicit key upsert overwrites existing value", () => {
    setCacheEntry("v1", { key: "same" });
    setCacheEntry("v2", { key: "same" });
    const result = getCacheEntry("same");
    expect(result).toEqual({ data: "v2" });
    // Only one entry in the store for this key.
    let count = 0;
    for (const k of _internals.store.keys()) {
      if (k === "same") count++;
    }
    expect(count).toBe(1);
  });

  test("upsert refreshes insertion order (LRU position)", () => {
    setCacheEntry("a", { key: "first" });
    setCacheEntry("b", { key: "second" });
    // Upsert 'first' — it should move to the end.
    setCacheEntry("a-updated", { key: "first" });

    const keys = [..._internals.store.keys()];
    expect(keys).toEqual(["second", "first"]);
  });

  test("upsert resets expiry timestamp", () => {
    setCacheEntry("v1", { key: "k", ttlMs: 1000 });
    const expiryBefore = _internals.store.get("k")!.expiresAt;

    // Small delay to ensure Date.now() advances.
    const start = Date.now();
    while (Date.now() === start) {
      /* busy-wait for at least 1ms */
    }

    setCacheEntry("v2", { key: "k", ttlMs: 5000 });
    const expiryAfter = _internals.store.get("k")!.expiresAt;
    expect(expiryAfter).toBeGreaterThan(expiryBefore);
  });
});

describe("getCacheEntry", () => {
  test("returns data for a valid key", () => {
    const { key } = setCacheEntry(42);
    expect(getCacheEntry(key)).toEqual({ data: 42 });
  });

  test("returns null for an unknown key", () => {
    expect(getCacheEntry("nonexistent")).toBeNull();
  });

  test("refreshes LRU position on access", () => {
    setCacheEntry("a", { key: "k1" });
    setCacheEntry("b", { key: "k2" });
    setCacheEntry("c", { key: "k3" });

    // Access k1 — should move to the end.
    getCacheEntry("k1");

    const keys = [..._internals.store.keys()];
    expect(keys).toEqual(["k2", "k3", "k1"]);
  });
});

describe("TTL expiry (lazy eviction)", () => {
  test("expired entry returns null and is removed from the store", () => {
    setCacheEntry("ephemeral", { key: "ttl-test", ttlMs: 1 });

    // Wait for the TTL to elapse.
    const deadline = Date.now() + 2;
    while (Date.now() < deadline) {
      /* busy-wait */
    }

    expect(getCacheEntry("ttl-test")).toBeNull();
    expect(_internals.store.has("ttl-test")).toBe(false);
  });

  test("non-expired entry is still accessible", () => {
    setCacheEntry("durable", { key: "long-lived", ttlMs: 60_000 });
    expect(getCacheEntry("long-lived")).toEqual({ data: "durable" });
  });

  test("default TTL is 30 minutes", () => {
    expect(_internals.DEFAULT_TTL_MS).toBe(30 * 60_000);
  });
});

describe("LRU eviction at capacity", () => {
  test("evicts oldest entry when at max capacity", () => {
    const maxEntries = _internals.DEFAULT_MAX_ENTRIES; // 64

    // Fill the store to capacity.
    for (let i = 0; i < maxEntries; i++) {
      setCacheEntry(i, { key: `entry-${i}` });
    }
    expect(_internals.store.size).toBe(maxEntries);

    // One more insert should evict the oldest (entry-0).
    setCacheEntry("overflow", { key: "new-entry" });
    expect(_internals.store.size).toBe(maxEntries);
    expect(getCacheEntry("entry-0")).toBeNull();
    expect(getCacheEntry("new-entry")).toEqual({ data: "overflow" });
  });

  test("default max entries is 64", () => {
    expect(_internals.DEFAULT_MAX_ENTRIES).toBe(64);
  });

  test("upsert at capacity does not evict (key already exists)", () => {
    const maxEntries = _internals.DEFAULT_MAX_ENTRIES;
    for (let i = 0; i < maxEntries; i++) {
      setCacheEntry(i, { key: `entry-${i}` });
    }

    // Upsert an existing key — should not evict anything.
    setCacheEntry("updated", { key: "entry-0" });
    expect(_internals.store.size).toBe(maxEntries);
    expect(getCacheEntry("entry-0")).toEqual({ data: "updated" });
    expect(getCacheEntry("entry-1")).toEqual({ data: 1 });
  });
});

describe("deleteCacheEntry", () => {
  test("returns true when deleting an existing key", () => {
    setCacheEntry("x", { key: "del" });
    expect(deleteCacheEntry("del")).toBe(true);
    expect(getCacheEntry("del")).toBeNull();
  });

  test("returns false for an unknown key (idempotent)", () => {
    expect(deleteCacheEntry("ghost")).toBe(false);
  });

  test("double delete is idempotent", () => {
    setCacheEntry("x", { key: "once" });
    expect(deleteCacheEntry("once")).toBe(true);
    expect(deleteCacheEntry("once")).toBe(false);
  });
});

describe("clearCacheForTests", () => {
  test("empties the entire store", () => {
    setCacheEntry("a", { key: "k1" });
    setCacheEntry("b", { key: "k2" });
    clearCacheForTests();
    expect(_internals.store.size).toBe(0);
  });
});
