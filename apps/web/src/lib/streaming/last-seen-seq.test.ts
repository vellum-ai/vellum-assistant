/**
 * Unit tests for the per-conversation seq cursor (last-seen-seq).
 */

import { describe, expect, test, beforeEach } from "bun:test";

import {
  __resetLastSeenSeqForTesting,
  clearLastSeenSeq,
  getLastSeenSeq,
  hydrateLastSeenSeqFromStorage,
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
