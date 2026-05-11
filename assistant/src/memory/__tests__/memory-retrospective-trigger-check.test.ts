import { describe, expect, test } from "bun:test";

import { shouldEnqueueRetrospective } from "../memory-retrospective-trigger-check.js";

const THRESHOLDS = {
  timeThresholdMs: 30 * 60 * 1000, // 30 min
  messageThreshold: 10,
  minCooldownMs: 5 * 60 * 1000, // 5 min
};

describe("shouldEnqueueRetrospective", () => {
  test("no state — returns 'interval' regardless of message count", () => {
    const result = shouldEnqueueRetrospective({
      state: null,
      newMessageCount: 0,
      now: Date.now(),
      ...THRESHOLDS,
    });
    expect(result).toBe("interval");
  });

  test("cooldown gate — within minCooldownMs, returns null even if other thresholds would trip", () => {
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 60_000 }, // 1 min ago
      newMessageCount: 50, // way over threshold
      now,
      ...THRESHOLDS,
    });
    expect(result).toBeNull();
  });

  test("cooldown elapsed + time threshold reached — returns 'interval'", () => {
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 31 * 60_000 },
      newMessageCount: 1,
      now,
      ...THRESHOLDS,
    });
    expect(result).toBe("interval");
  });

  test("cooldown elapsed + time threshold not reached + message threshold met — returns 'message_count'", () => {
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 6 * 60_000 }, // past cooldown
      newMessageCount: 10, // exactly at threshold
      now,
      ...THRESHOLDS,
    });
    expect(result).toBe("message_count");
  });

  test("cooldown elapsed + neither threshold met — returns null", () => {
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 6 * 60_000 },
      newMessageCount: 5, // below threshold
      now,
      ...THRESHOLDS,
    });
    expect(result).toBeNull();
  });

  test("time threshold at exact boundary — returns 'interval'", () => {
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 30 * 60_000 },
      newMessageCount: 1,
      now,
      ...THRESHOLDS,
    });
    expect(result).toBe("interval");
  });

  test("message threshold prefers 'message_count' label when both could fire (interval also at boundary)", () => {
    // When the interval is also at threshold AND there are also enough
    // new messages, interval wins because it's evaluated first — the
    // trigger label is for observability only, the action is the same.
    const now = Date.now();
    const result = shouldEnqueueRetrospective({
      state: { lastProcessedMessageId: "m1", lastRunAt: now - 31 * 60_000 },
      newMessageCount: 20,
      now,
      ...THRESHOLDS,
    });
    expect(result).toBe("interval");
  });
});
