/**
 * Tests for `hasReceivedUserMessage()` — the warm-pool background-job gate.
 *
 * Strategy: stub `rawGet` so we can simulate three states:
 *   1. No user message in standard conversations → gate closed.
 *   2. A user message exists → gate open, subsequent calls cached.
 *   3. `rawGet` throws → gate stays closed (fail-conservative).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let rawGetImpl: () => unknown = () => null;
let rawGetCalls = 0;

mock.module("../../memory/raw-query.js", () => ({
  rawGet: () => {
    rawGetCalls += 1;
    return rawGetImpl();
  },
}));

// Import after mocks are wired so the module captures the mocked rawGet.
const { hasReceivedUserMessage, _resetPreFirstMessageGateCacheForTests } =
  await import("../pre-first-message-gate.js");

beforeEach(() => {
  _resetPreFirstMessageGateCacheForTests();
  rawGetCalls = 0;
  rawGetImpl = () => null;
});

describe("hasReceivedUserMessage", () => {
  test("returns false when no user message exists in standard conversations", () => {
    rawGetImpl = () => null;

    expect(hasReceivedUserMessage()).toBe(false);
    expect(rawGetCalls).toBe(1);
  });

  test("returns true when at least one user message exists", () => {
    rawGetImpl = () => ({ one: 1 });

    expect(hasReceivedUserMessage()).toBe(true);
    expect(rawGetCalls).toBe(1);
  });

  test("caches `true` result — subsequent calls do not re-query", () => {
    rawGetImpl = () => ({ one: 1 });

    expect(hasReceivedUserMessage()).toBe(true);
    expect(hasReceivedUserMessage()).toBe(true);
    expect(hasReceivedUserMessage()).toBe(true);

    // Only the first call hits the DB.
    expect(rawGetCalls).toBe(1);
  });

  test("does NOT cache `false` result — re-queries each time so the gate opens once the user interacts", () => {
    rawGetImpl = () => null;
    expect(hasReceivedUserMessage()).toBe(false);
    expect(hasReceivedUserMessage()).toBe(false);
    expect(rawGetCalls).toBe(2);

    // Simulate the user sending their first message — gate flips on next call.
    rawGetImpl = () => ({ one: 1 });
    expect(hasReceivedUserMessage()).toBe(true);
    expect(rawGetCalls).toBe(3);

    // And now the cache kicks in.
    expect(hasReceivedUserMessage()).toBe(true);
    expect(rawGetCalls).toBe(3);
  });

  test("returns false (and logs) when rawGet throws — fail-conservative so background work stays paused", () => {
    rawGetImpl = () => {
      throw new Error("schema not initialized");
    };

    expect(hasReceivedUserMessage()).toBe(false);
    expect(rawGetCalls).toBe(1);
  });
});
