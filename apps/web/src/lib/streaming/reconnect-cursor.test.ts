/**
 * Unit tests for the single global reconnect cursor used to resume the
 * unfiltered assistant SSE stream.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  __resetReconnectCursorForTesting,
  getReconnectCursor,
  recordReconnectSeq,
} from "@/lib/streaming/reconnect-cursor";

beforeEach(() => {
  __resetReconnectCursorForTesting();
});

describe("reconnect-cursor", () => {
  test("returns null before any event is recorded", () => {
    /**
     * A cold connection has no cursor to resume from.
     */

    // GIVEN no event has been recorded
    // WHEN we read the cursor
    const result = getReconnectCursor();

    // THEN it should be null
    expect(result).toBeNull();
  });

  test("records the first seq seen", () => {
    /**
     * The first event establishes the cursor regardless of its value.
     */

    // GIVEN no event has been recorded
    // WHEN we record seq=7
    recordReconnectSeq(7);

    // THEN the cursor should be 7
    expect(getReconnectCursor()).toBe(7);
  });

  test("advances monotonically and ignores lower or equal values", () => {
    /**
     * The cursor tracks the highest global seq applied; out-of-order or
     * duplicate events must never lower it.
     */

    // GIVEN the cursor has advanced to 10
    recordReconnectSeq(10);

    // WHEN we record a higher, then a lower, then an equal seq
    recordReconnectSeq(11);
    recordReconnectSeq(4);
    recordReconnectSeq(11);

    // THEN the cursor should hold the highest value seen
    expect(getReconnectCursor()).toBe(11);
  });
});
