import { beforeEach, describe, expect, test } from "bun:test";

import {
  advanceReconnectCursor,
  getReconnectCursor,
  replaceReconnectCursor,
  resetReconnectCursor,
} from "@/lib/streaming/reconnect-cursor";

beforeEach(() => {
  resetReconnectCursor();
});

describe("reconnect-cursor", () => {
  test("starts null before any event is seen", () => {
    // GIVEN a fresh cursor
    // THEN it reads null until an event seeds it
    expect(getReconnectCursor()).toBeNull();
  });

  test("advance seeds the cursor from null", () => {
    // GIVEN a fresh cursor
    // WHEN the first event advances it
    advanceReconnectCursor(5);

    // THEN the cursor holds that seq
    expect(getReconnectCursor()).toBe(5);
  });

  test("advance is monotonic — never lowers the cursor", () => {
    // GIVEN a cursor at seq 10
    advanceReconnectCursor(10);

    // WHEN a lower (out-of-order) seq is advanced
    advanceReconnectCursor(7);

    // THEN the cursor stays at the higher value
    expect(getReconnectCursor()).toBe(10);

    // AND a higher seq still moves it forward
    advanceReconnectCursor(11);
    expect(getReconnectCursor()).toBe(11);
  });

  test("replace unconditionally sets the cursor, even backwards", () => {
    // GIVEN a cursor at seq 500
    advanceReconnectCursor(500);

    // WHEN replace is called with a lower seq (daemon counter reset)
    replaceReconnectCursor(3);

    // THEN the cursor adopts the lower value (abandons monotonicity)
    expect(getReconnectCursor()).toBe(3);
  });

  test("reset returns the cursor to null", () => {
    // GIVEN a cursor with a value
    advanceReconnectCursor(42);

    // WHEN it is reset (e.g. attaching a connection for a new assistant)
    resetReconnectCursor();

    // THEN it reads null again — the next connect starts cold
    expect(getReconnectCursor()).toBeNull();
  });
});
