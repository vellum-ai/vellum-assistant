import { describe, expect, test } from "bun:test";

import {
  MessageQueue,
  type QueuedMessage,
} from "../daemon/conversation-queue-manager.js";

function makeItem(content: string, requestId: string): QueuedMessage {
  return {
    content,
    attachments: [],
    requestId,
    onEvent: () => {},
    sentAt: Date.now(),
  };
}

describe("MessageQueue.promoteToHead", () => {
  test("returns undefined when queue is empty", () => {
    const q = new MessageQueue();
    expect(q.promoteToHead("nonexistent")).toBeUndefined();
  });

  test("returns undefined when requestId is not found", () => {
    const q = new MessageQueue();
    q.push(makeItem("a", "r1"));
    q.push(makeItem("b", "r2"));
    expect(q.promoteToHead("r99")).toBeUndefined();
    // Queue unchanged
    expect(q.peek(0)?.requestId).toBe("r1");
    expect(q.peek(1)?.requestId).toBe("r2");
  });

  test("no-op when the message is already at head", () => {
    const q = new MessageQueue();
    q.push(makeItem("a", "r1"));
    q.push(makeItem("b", "r2"));

    const bytesBefore = q.totalBytes;
    const result = q.promoteToHead("r1");

    expect(result).toBeDefined();
    expect(result?.requestId).toBe("r1");
    expect(q.peek(0)?.requestId).toBe("r1");
    expect(q.peek(1)?.requestId).toBe("r2");
    expect(q.length).toBe(2);
    expect(q.totalBytes).toBe(bytesBefore);
  });

  test("moves a middle item to head", () => {
    const q = new MessageQueue();
    q.push(makeItem("a", "r1"));
    q.push(makeItem("b", "r2"));
    q.push(makeItem("c", "r3"));

    const bytesBefore = q.totalBytes;
    const result = q.promoteToHead("r2");

    expect(result).toBeDefined();
    expect(result?.requestId).toBe("r2");
    expect(q.peek(0)?.requestId).toBe("r2");
    expect(q.peek(1)?.requestId).toBe("r1");
    expect(q.peek(2)?.requestId).toBe("r3");
    expect(q.length).toBe(3);
    expect(q.totalBytes).toBe(bytesBefore);
  });

  test("moves the last item to head", () => {
    const q = new MessageQueue();
    q.push(makeItem("a", "r1"));
    q.push(makeItem("b", "r2"));
    q.push(makeItem("c", "r3"));

    const bytesBefore = q.totalBytes;
    const result = q.promoteToHead("r3");

    expect(result).toBeDefined();
    expect(result?.requestId).toBe("r3");
    expect(q.peek(0)?.requestId).toBe("r3");
    expect(q.peek(1)?.requestId).toBe("r1");
    expect(q.peek(2)?.requestId).toBe("r2");
    expect(q.length).toBe(3);
    expect(q.totalBytes).toBe(bytesBefore);
  });

  test("byte accounting unchanged after promote (item is reordered, not added/removed)", () => {
    const q = new MessageQueue(10_000);
    q.push(makeItem("short", "r1"));
    q.push(makeItem("a".repeat(200), "r2"));
    q.push(makeItem("medium text", "r3"));

    const bytesBefore = q.totalBytes;
    q.promoteToHead("r2");
    expect(q.totalBytes).toBe(bytesBefore);

    // shift all and verify bytes go to 0
    q.shift();
    q.shift();
    q.shift();
    expect(q.totalBytes).toBe(0);
  });

  test("promoted item is returned by shift()", () => {
    const q = new MessageQueue();
    q.push(makeItem("a", "r1"));
    q.push(makeItem("b", "r2"));
    q.push(makeItem("c", "r3"));

    q.promoteToHead("r3");
    const head = q.shift();
    expect(head?.requestId).toBe("r3");
    expect(head?.content).toBe("c");
  });
});
