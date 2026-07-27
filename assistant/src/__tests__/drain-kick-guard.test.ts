/**
 * kickQueueDrain — the never-rejecting drain trigger.
 *
 * Fire-and-forget drain sites (the agent loop's `finally`, route handlers
 * releasing the processing lock) call kickQueueDrain instead of drainQueue
 * directly. A drain whose promise rejects has nothing left to re-trigger it,
 * so the guard retries once, and on a second failure notifies every queued
 * sender while leaving the queue intact for the next drain trigger.
 */
import { describe, expect, test } from "bun:test";

import { kickQueueDrain } from "../daemon/conversation-process.js";
import {
  MessageQueue,
  type QueuedMessage,
} from "../daemon/conversation-queue-manager.js";

interface FakeEvent {
  type: string;
  message?: string;
  category?: string;
  requestId?: string;
}

/**
 * MessageQueue whose `peek` throws for the first `peekFailures` calls.
 * `drainQueue`'s batch builder reads `peek(0)` before anything else, so
 * each induced failure rejects exactly one drain attempt.
 */
class FlakyQueue extends MessageQueue {
  peekFailures = 0;

  override peek(index: number = 0): QueuedMessage | undefined {
    if (this.peekFailures > 0) {
      this.peekFailures -= 1;
      throw new Error("batch build exploded");
    }
    return super.peek(index);
  }
}

function makeQueued(
  content: string,
  requestId: string,
  events: FakeEvent[],
): QueuedMessage {
  return {
    content,
    attachments: [],
    requestId,
    onEvent: (event: FakeEvent) => {
      events.push(event);
    },
    sentAt: Date.now(),
  } as unknown as QueuedMessage;
}

function makeFakeConversation(options: { persistError?: Error } = {}) {
  const queue = new FlakyQueue();
  const persistCalls: string[] = [];
  const conversation = {
    conversationId: "conv-drain-kick",
    queue,
    pendingSteerRepair: false,
    preactivatedSkillIds: undefined as string[] | undefined,
    messages: [] as unknown[],
    surfaceActionRequestIds: new Set<string>(),
    activeSurfaceId: undefined,
    ensureHostProxiesForTurn: () => {},
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    getTurnChannelContext: () => null,
    setTurnChannelContext: () => {},
    getTurnInterfaceContext: () => null,
    setTurnInterfaceContext: () => {},
    setTransportHints: () => {},
    emitActivityState: () => {},
    isProcessing: () => false,
    persistUserMessage: async (opts: { content: string }) => {
      persistCalls.push(opts.content);
      if (options.persistError) {
        throw options.persistError;
      }
      return { id: `msg-${persistCalls.length}`, deduplicated: true };
    },
  };
  return { conversation, queue, persistCalls };
}

describe("kickQueueDrain", () => {
  test("a drain that rejects is retried once and the retry drains the queue", async () => {
    const events: FakeEvent[] = [];
    // Persist fails with a non-busy error so the retry terminates on the
    // drop-and-continue path instead of entering the full agent loop.
    const { conversation, queue, persistCalls } = makeFakeConversation({
      persistError: new Error("disk exploded"),
    });
    queue.push(makeQueued("hello there", "r1", events));
    queue.peekFailures = 1;

    await kickQueueDrain(conversation as never);

    // The first attempt rejected before touching the queue; the retry got
    // all the way to persist — the queue did not strand.
    expect(persistCalls.length).toBe(1);
    expect(queue.length).toBe(0);
    expect(
      events.filter((event) => event.category === "queue_drain_failed"),
    ).toEqual([]);
  });

  test("a second failure notifies every queued sender and keeps the queue intact", async () => {
    const events: FakeEvent[] = [];
    const { conversation, queue, persistCalls } = makeFakeConversation();
    queue.push(makeQueued("first", "r1", events));
    queue.push(makeQueued("second", "r2", events));
    queue.peekFailures = 2;

    await kickQueueDrain(conversation as never);

    // Both attempts rejected: nothing was drained or dropped, and each
    // sender received a queue_drain_failed error so the stall is visible.
    expect(persistCalls).toEqual([]);
    expect(queue.length).toBe(2);
    expect(queue.peek(0)?.requestId).toBe("r1");
    expect(queue.peek(1)?.requestId).toBe("r2");
    const failures = events.filter(
      (event) =>
        event.type === "error" && event.category === "queue_drain_failed",
    );
    expect(failures.map((event) => event.requestId).sort()).toEqual([
      "r1",
      "r2",
    ]);
  });

  test("a healthy drain runs once with no retry and no failure events", async () => {
    const events: FakeEvent[] = [];
    const { conversation, queue, persistCalls } = makeFakeConversation({
      persistError: new Error("disk exploded"),
    });
    queue.push(makeQueued("hello there", "r1", events));

    await kickQueueDrain(conversation as never);

    expect(persistCalls.length).toBe(1);
    expect(queue.length).toBe(0);
    expect(
      events.filter((event) => event.category === "queue_drain_failed"),
    ).toEqual([]);
  });
});
