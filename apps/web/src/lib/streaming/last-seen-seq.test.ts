/**
 * Unit tests for the per-conversation seq cursor (last-seen-seq).
 */

import { describe, expect, test, beforeEach } from "bun:test";

import {
  __resetLastSeenSeqForTesting,
  clearLastSeenSeq,
  getLastSeenSeq,
  hydrateLastSeenSeqFromStorage,
  MAX_TRACKED_CONVERSATIONS,
  replaceLastSeenSeq,
  setLastSeenSeq,
} from "@/lib/streaming/last-seen-seq";

beforeEach(() => {
  __resetLastSeenSeqForTesting();
});

describe("getLastSeenSeq", () => {
  test("returns null for unknown conversation", () => {
    /**
     * A conversation with no recorded seq should return null.
     */

    // GIVEN no seq has been recorded for a conversation
    // WHEN we read the seq
    const result = getLastSeenSeq("conv-1");

    // THEN it should return null
    expect(result).toBeNull();
  });
});

describe("setLastSeenSeq", () => {
  test("stores and retrieves a seq value", () => {
    /**
     * After storing a seq, getLastSeenSeq should return it.
     */

    // GIVEN a conversation with no recorded seq
    // WHEN we store seq=5
    setLastSeenSeq("conv-1", 5);

    // THEN getLastSeenSeq should return 5
    expect(getLastSeenSeq("conv-1")).toBe(5);
  });

  test("enforces monotonic writes — rejects lower values", () => {
    /**
     * setLastSeenSeq should only update if the new value is strictly greater.
     */

    // GIVEN a conversation with seq=10
    setLastSeenSeq("conv-1", 10);

    // WHEN we attempt to store seq=5 (lower)
    setLastSeenSeq("conv-1", 5);

    // THEN the stored value should remain 10
    expect(getLastSeenSeq("conv-1")).toBe(10);
  });

  test("enforces monotonic writes — rejects equal values", () => {
    /**
     * setLastSeenSeq should not update if the new value equals the current.
     */

    // GIVEN a conversation with seq=10
    setLastSeenSeq("conv-1", 10);

    // WHEN we attempt to store seq=10 (equal)
    setLastSeenSeq("conv-1", 10);

    // THEN the stored value should remain 10
    expect(getLastSeenSeq("conv-1")).toBe(10);
  });

  test("accepts strictly greater values", () => {
    /**
     * setLastSeenSeq should accept values strictly greater than current.
     */

    // GIVEN a conversation with seq=10
    setLastSeenSeq("conv-1", 10);

    // WHEN we store seq=11 (greater)
    setLastSeenSeq("conv-1", 11);

    // THEN the stored value should be 11
    expect(getLastSeenSeq("conv-1")).toBe(11);
  });

  test("isolates conversations", () => {
    /**
     * Seq values should be independent per conversation.
     */

    // GIVEN two conversations with different seq values
    setLastSeenSeq("conv-1", 5);
    setLastSeenSeq("conv-2", 10);

    // WHEN we read each conversation's seq
    // THEN each should return its own value
    expect(getLastSeenSeq("conv-1")).toBe(5);
    expect(getLastSeenSeq("conv-2")).toBe(10);
  });

  test("writes through to localStorage", () => {
    /**
     * setLastSeenSeq should persist to localStorage for cross-session survival.
     */

    // GIVEN a seq is stored
    setLastSeenSeq("conv-1", 42);

    // WHEN we read from localStorage directly
    const raw = localStorage.getItem("vellum.lastSeenSeq.conv-1");

    // THEN it should have the stored value
    expect(raw).toBe("42");
  });
});

describe("hydrateLastSeenSeqFromStorage", () => {
  test("restores values from localStorage", () => {
    /**
     * After a page reload, hydrate should restore seq cursors from localStorage.
     */

    // GIVEN localStorage has a seq value
    localStorage.setItem("vellum.lastSeenSeq.conv-1", "7");

    // WHEN we hydrate
    hydrateLastSeenSeqFromStorage();

    // THEN getLastSeenSeq should return the stored value
    expect(getLastSeenSeq("conv-1")).toBe(7);
  });

  test("skips non-numeric localStorage values", () => {
    /**
     * Corrupt localStorage entries should be ignored.
     */

    // GIVEN localStorage has a non-numeric value
    localStorage.setItem("vellum.lastSeenSeq.conv-1", "not-a-number");

    // WHEN we hydrate
    hydrateLastSeenSeqFromStorage();

    // THEN getLastSeenSeq should return null
    expect(getLastSeenSeq("conv-1")).toBeNull();
  });

  test("skips negative localStorage values", () => {
    /**
     * Negative seq values should be ignored as invalid.
     */

    // GIVEN localStorage has a negative value
    localStorage.setItem("vellum.lastSeenSeq.conv-1", "-1");

    // WHEN we hydrate
    hydrateLastSeenSeqFromStorage();

    // THEN getLastSeenSeq should return null
    expect(getLastSeenSeq("conv-1")).toBeNull();
  });

  test("does not overwrite in-memory values with smaller localStorage values", () => {
    /**
     * Hydrate should respect monotonicity if in-memory is already ahead.
     */

    // GIVEN in-memory has seq=20
    setLastSeenSeq("conv-1", 20);

    // AND localStorage has a smaller value
    localStorage.setItem("vellum.lastSeenSeq.conv-1", "10");

    // WHEN we hydrate
    hydrateLastSeenSeqFromStorage();

    // THEN the in-memory value should be preserved
    expect(getLastSeenSeq("conv-1")).toBe(20);
  });

  test("is idempotent", () => {
    /**
     * Calling hydrate multiple times should be safe.
     */

    // GIVEN localStorage has a value
    localStorage.setItem("vellum.lastSeenSeq.conv-1", "5");

    // WHEN we hydrate twice
    hydrateLastSeenSeqFromStorage();
    hydrateLastSeenSeqFromStorage();

    // THEN the value should be correct
    expect(getLastSeenSeq("conv-1")).toBe(5);
  });
});

describe("clearLastSeenSeq", () => {
  test("removes in-memory and localStorage entries", () => {
    /**
     * Clearing a conversation should remove from both stores.
     */

    // GIVEN a conversation with a stored seq
    setLastSeenSeq("conv-1", 10);

    // WHEN we clear it
    clearLastSeenSeq("conv-1");

    // THEN the in-memory value should be null
    expect(getLastSeenSeq("conv-1")).toBeNull();

    // AND localStorage should not have the key
    expect(localStorage.getItem("vellum.lastSeenSeq.conv-1")).toBeNull();
  });

  test("does not affect other conversations", () => {
    /**
     * Clearing one conversation should not touch others.
     */

    // GIVEN two conversations with stored seqs
    setLastSeenSeq("conv-1", 10);
    setLastSeenSeq("conv-2", 20);

    // WHEN we clear conv-1
    clearLastSeenSeq("conv-1");

    // THEN conv-2 should be unaffected
    expect(getLastSeenSeq("conv-2")).toBe(20);
  });
});

describe("replaceLastSeenSeq", () => {
  test("replaces a higher value with a lower value", () => {
    /**
     * After a server restart, seq counters reset. replaceLastSeenSeq
     * must accept the lower value unconditionally.
     */

    // GIVEN a conversation with a high stored seq
    setLastSeenSeq("conv-1", 500);

    // WHEN we replace with a low seq (server restarted)
    replaceLastSeenSeq("conv-1", 1);

    // THEN the stored value should be the new low value
    expect(getLastSeenSeq("conv-1")).toBe(1);
  });

  test("writes through to localStorage", () => {
    /**
     * replaceLastSeenSeq should persist the replacement to localStorage.
     */

    // GIVEN a conversation with a high stored seq
    setLastSeenSeq("conv-1", 500);

    // WHEN we replace with a lower value
    replaceLastSeenSeq("conv-1", 3);

    // THEN localStorage should have the new value
    expect(localStorage.getItem("vellum.lastSeenSeq.conv-1")).toBe("3");
  });

  test("subsequent monotonic writes work from the new baseline", () => {
    /**
     * After a replace, setLastSeenSeq should accept values above the
     * new baseline.
     */

    // GIVEN a conversation replaced to seq=1 (server restart)
    setLastSeenSeq("conv-1", 500);
    replaceLastSeenSeq("conv-1", 1);

    // WHEN we set seq=2 (next event in new generation)
    setLastSeenSeq("conv-1", 2);

    // THEN the stored value should advance to 2
    expect(getLastSeenSeq("conv-1")).toBe(2);
  });
});

describe("LRU eviction", () => {
  test("evicts the oldest entry when the cap is exceeded via setLastSeenSeq", () => {
    /**
     * Filling the map beyond MAX_TRACKED_CONVERSATIONS should evict the
     * least-recently-written entry from both memory and localStorage.
     */

    // GIVEN MAX_TRACKED_CONVERSATIONS conversations have been stored
    for (let i = 0; i < MAX_TRACKED_CONVERSATIONS; i++) {
      setLastSeenSeq(`conv-${i}`, i + 1);
    }

    // WHEN we store one more (exceeding the cap)
    setLastSeenSeq("conv-overflow", 999);

    // THEN the oldest (conv-0) should be evicted
    expect(getLastSeenSeq("conv-0")).toBeNull();
    expect(localStorage.getItem("vellum.lastSeenSeq.conv-0")).toBeNull();

    // AND the new entry should be present
    expect(getLastSeenSeq("conv-overflow")).toBe(999);

    // AND the second-oldest should still be present
    expect(getLastSeenSeq("conv-1")).toBe(2);
  });

  test("evicts the oldest entry when the cap is exceeded via replaceLastSeenSeq", () => {
    /**
     * replaceLastSeenSeq should also trigger eviction when over capacity.
     */

    // GIVEN MAX_TRACKED_CONVERSATIONS conversations have been stored
    for (let i = 0; i < MAX_TRACKED_CONVERSATIONS; i++) {
      setLastSeenSeq(`conv-${i}`, i + 1);
    }

    // WHEN we replace a new conversation (exceeding the cap)
    replaceLastSeenSeq("conv-overflow", 1);

    // THEN the oldest (conv-0) should be evicted
    expect(getLastSeenSeq("conv-0")).toBeNull();
    expect(localStorage.getItem("vellum.lastSeenSeq.conv-0")).toBeNull();

    // AND the new entry should be present
    expect(getLastSeenSeq("conv-overflow")).toBe(1);
  });

  test("writing to an existing conversation promotes it and does not evict", () => {
    /**
     * Updating an existing entry should promote it to the end of the
     * LRU order without evicting anything, since the map size stays
     * the same.
     */

    // GIVEN MAX_TRACKED_CONVERSATIONS conversations have been stored
    for (let i = 0; i < MAX_TRACKED_CONVERSATIONS; i++) {
      setLastSeenSeq(`conv-${i}`, i + 1);
    }

    // WHEN we update the oldest conversation (conv-0)
    setLastSeenSeq("conv-0", 1000);

    // THEN conv-0 should still be present with the new value
    expect(getLastSeenSeq("conv-0")).toBe(1000);

    // AND no other conversations should have been evicted
    expect(getLastSeenSeq("conv-1")).toBe(2);
    expect(getLastSeenSeq(`conv-${MAX_TRACKED_CONVERSATIONS - 1}`)).toBe(
      MAX_TRACKED_CONVERSATIONS,
    );
  });

  test("promoting an entry changes the eviction order", () => {
    /**
     * After promoting conv-0, the next eviction should remove conv-1
     * (now the oldest) instead of conv-0.
     */

    // GIVEN MAX_TRACKED_CONVERSATIONS conversations
    for (let i = 0; i < MAX_TRACKED_CONVERSATIONS; i++) {
      setLastSeenSeq(`conv-${i}`, i + 1);
    }

    // AND conv-0 is promoted by writing to it
    setLastSeenSeq("conv-0", 1000);

    // WHEN we add a new conversation (exceeding the cap)
    setLastSeenSeq("conv-overflow", 999);

    // THEN conv-1 (now the oldest) should be evicted, not conv-0
    expect(getLastSeenSeq("conv-0")).toBe(1000);
    expect(getLastSeenSeq("conv-1")).toBeNull();
    expect(getLastSeenSeq("conv-overflow")).toBe(999);
  });
});

describe("hydrateLastSeenSeqFromStorage GC", () => {
  test("prunes localStorage entries exceeding the cap during hydration", () => {
    /**
     * If localStorage accumulated more keys than the cap (e.g., from a
     * previous version without GC), hydrate should prune the excess
     * entries with the lowest seq values.
     */

    // GIVEN localStorage has more entries than MAX_TRACKED_CONVERSATIONS
    const total = MAX_TRACKED_CONVERSATIONS + 10;
    for (let i = 0; i < total; i++) {
      localStorage.setItem(`vellum.lastSeenSeq.conv-${i}`, String(i + 1));
    }

    // WHEN we hydrate
    hydrateLastSeenSeqFromStorage();

    // THEN the 10 conversations with the lowest seqs should be pruned
    // from localStorage (conv-0 through conv-9 have seq 1..10)
    for (let i = 0; i < 10; i++) {
      expect(localStorage.getItem(`vellum.lastSeenSeq.conv-${i}`)).toBeNull();
    }

    // AND the remaining conversations should be in memory
    for (let i = 10; i < total; i++) {
      expect(getLastSeenSeq(`conv-${i}`)).toBe(i + 1);
    }
  });
});
