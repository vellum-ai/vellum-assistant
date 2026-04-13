import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MAX_QUEUE_BYTES,
  MessageQueue,
  type QueuedMessage,
} from "../daemon/conversation-queue-manager.js";

function makeItem(content: string, requestId = "r"): QueuedMessage {
  return {
    content,
    attachments: [],
    requestId,
    onEvent: () => {},
    sentAt: Date.now(),
  };
}

describe("MessageQueue.peek", () => {
  test("peek(0) on empty queue returns undefined", () => {
    const q = new MessageQueue();
    expect(q.peek(0)).toBeUndefined();
  });

  test("peek(0) on non-empty queue returns head without mutating length or totalBytes", () => {
    const q = new MessageQueue();
    q.push(makeItem("first", "r1"));
    q.push(makeItem("second", "r2"));

    const lengthBefore = q.length;
    const bytesBefore = q.totalBytes;

    const head = q.peek(0);
    expect(head).toBeDefined();
    expect(head?.requestId).toBe("r1");
    expect(head?.content).toBe("first");

    expect(q.length).toBe(lengthBefore);
    expect(q.totalBytes).toBe(bytesBefore);
  });

  test("peek(2) returns the third item; peek(99) returns undefined", () => {
    const q = new MessageQueue();
    q.push(makeItem("a", "r1"));
    q.push(makeItem("b", "r2"));
    q.push(makeItem("c", "r3"));

    expect(q.peek(2)?.requestId).toBe("r3");
    expect(q.peek(99)).toBeUndefined();
  });
});

describe("MessageQueue.shiftN", () => {
  test("shiftN(0) returns [] and does not mutate", () => {
    const q = new MessageQueue();
    q.push(makeItem("a", "r1"));
    q.push(makeItem("b", "r2"));

    const lengthBefore = q.length;
    const bytesBefore = q.totalBytes;

    const popped = q.shiftN(0);
    expect(popped).toEqual([]);
    expect(q.length).toBe(lengthBefore);
    expect(q.totalBytes).toBe(bytesBefore);
  });

  test("shiftN(2) on a 3-item queue returns the first two in FIFO order; length becomes 1; totalBytes matches remaining", () => {
    const q = new MessageQueue();
    q.push(makeItem("a", "r1"));
    q.push(makeItem("b", "r2"));
    q.push(makeItem("c", "r3"));

    // Capture the remaining-item bytes by draining a fresh queue with just "c".
    const reference = new MessageQueue();
    reference.push(makeItem("c", "r3"));
    const expectedRemainingBytes = reference.totalBytes;

    const popped = q.shiftN(2);
    expect(popped.map((m) => m.requestId)).toEqual(["r1", "r2"]);
    expect(q.length).toBe(1);
    expect(q.totalBytes).toBe(expectedRemainingBytes);
    expect(q.peek(0)?.requestId).toBe("r3");
  });

  test("shiftN(99) on a 3-item queue returns all three; length becomes 0; totalBytes becomes 0", () => {
    const q = new MessageQueue();
    q.push(makeItem("a", "r1"));
    q.push(makeItem("b", "r2"));
    q.push(makeItem("c", "r3"));

    const popped = q.shiftN(99);
    expect(popped.map((m) => m.requestId)).toEqual(["r1", "r2", "r3"]);
    expect(q.length).toBe(0);
    expect(q.totalBytes).toBe(0);
  });

  test("after shiftN, a subsequent push up to the budget still succeeds (byte accounting not drifted)", () => {
    // Tight budget so we can verify the freed bytes are exactly correct.
    // Each 500-char item ≈ 500*2 + 512 = 1512 bytes.
    // Budget of 3000 fits two items (3024 > 3000 — actually only one, since 1512+1512=3024 exceeds).
    // Use 4000: fits two (3024) but not three (4536).
    const q = new MessageQueue(4_000);
    expect(q.push(makeItem("a".repeat(500), "r1"))).toBe(true);
    expect(q.push(makeItem("b".repeat(500), "r2"))).toBe(true);
    expect(q.push(makeItem("c".repeat(500), "r3"))).toBe(false);

    // Drain both — budget should be fully reclaimed.
    const popped = q.shiftN(2);
    expect(popped).toHaveLength(2);
    expect(q.totalBytes).toBe(0);

    // Now we should be able to push two fresh items again.
    expect(q.push(makeItem("d".repeat(500), "r4"))).toBe(true);
    expect(q.push(makeItem("e".repeat(500), "r5"))).toBe(true);
    expect(q.length).toBe(2);
  });
});

describe("MessageQueue exports", () => {
  test("DEFAULT_MAX_QUEUE_BYTES is importable and positive", () => {
    expect(typeof DEFAULT_MAX_QUEUE_BYTES).toBe("number");
    expect(DEFAULT_MAX_QUEUE_BYTES).toBeGreaterThan(0);
  });
});
