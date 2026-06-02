/**
 * Unit tests for the per-conversation clientSeq watermark
 * (last-seen-seq) used by gap detection.
 */

import { describe, expect, test, beforeEach } from "bun:test";

import {
  __resetLastSeenSeqForTesting,
  clearLastSeenSeq,
  getGapDetectionCursors,
  getLastSeenSeq,
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
     * A conversation with no recorded watermark should return null.
     */

    // GIVEN no watermark has been recorded for a conversation
    // WHEN we read the watermark
    const result = getLastSeenSeq("conv-1");

    // THEN it should return null
    expect(result).toBeNull();
  });
});

describe("setLastSeenSeq", () => {
  test("stores and retrieves a value", () => {
    /**
     * After storing a watermark, getLastSeenSeq should return it.
     */

    // GIVEN a conversation with no recorded watermark
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
     * Watermarks should be independent per conversation.
     */

    // GIVEN two conversations with different watermark values
    setLastSeenSeq("conv-1", 5);
    setLastSeenSeq("conv-2", 10);

    // WHEN we read each conversation's watermark
    // THEN each should return its own value
    expect(getLastSeenSeq("conv-1")).toBe(5);
    expect(getLastSeenSeq("conv-2")).toBe(10);
  });
});

describe("clearLastSeenSeq", () => {
  test("removes the watermark", () => {
    /**
     * Clearing a conversation should remove its watermark.
     */

    // GIVEN a conversation with a stored watermark
    setLastSeenSeq("conv-1", 10);

    // WHEN we clear it
    clearLastSeenSeq("conv-1");

    // THEN getLastSeenSeq should return null
    expect(getLastSeenSeq("conv-1")).toBeNull();
  });

  test("does not affect other conversations", () => {
    /**
     * Clearing one conversation should not touch others.
     */

    // GIVEN two conversations with stored watermarks
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
     * On a new SSE subscription clientSeq resets to 1, so
     * replaceLastSeenSeq must accept a lower value unconditionally.
     */

    // GIVEN a conversation with a high stored watermark
    setLastSeenSeq("conv-1", 500);

    // WHEN we replace with a low value (new subscription)
    replaceLastSeenSeq("conv-1", 1);

    // THEN the stored value should be the new low value
    expect(getLastSeenSeq("conv-1")).toBe(1);
  });

  test("subsequent monotonic writes work from the new baseline", () => {
    /**
     * After a replace, setLastSeenSeq should accept values above the
     * new baseline.
     */

    // GIVEN a conversation replaced to seq=1 (new subscription)
    setLastSeenSeq("conv-1", 500);
    replaceLastSeenSeq("conv-1", 1);

    // WHEN we set seq=2 (next event in the new subscription)
    setLastSeenSeq("conv-1", 2);

    // THEN the stored value should advance to 2
    expect(getLastSeenSeq("conv-1")).toBe(2);
  });
});

describe("getGapDetectionCursors", () => {
  test("returns a snapshot of all watermarks", () => {
    /**
     * The debug snapshot should mirror every tracked conversation.
     */

    // GIVEN two conversations with watermarks
    setLastSeenSeq("conv-1", 5);
    setLastSeenSeq("conv-2", 10);

    // WHEN we read the snapshot
    const snapshot = getGapDetectionCursors();

    // THEN it should contain both conversations
    expect(snapshot).toEqual({ "conv-1": 5, "conv-2": 10 });
  });
});

describe("LRU eviction", () => {
  test("evicts the oldest entry when the cap is exceeded via setLastSeenSeq", () => {
    /**
     * Filling the map beyond MAX_TRACKED_CONVERSATIONS should evict the
     * least-recently-written entry.
     */

    // GIVEN MAX_TRACKED_CONVERSATIONS conversations have been stored
    for (let i = 0; i < MAX_TRACKED_CONVERSATIONS; i++) {
      setLastSeenSeq(`conv-${i}`, i + 1);
    }

    // WHEN we store one more (exceeding the cap)
    setLastSeenSeq("conv-overflow", 999);

    // THEN the oldest (conv-0) should be evicted
    expect(getLastSeenSeq("conv-0")).toBeNull();

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
