/**
 * Queue-drain behavior under processing-lock contention.
 *
 * When another turn (e.g. a barged-in voice turn woken by the idle
 * transition) takes the lock between a drain's dequeue and its persist,
 * the dequeued message must be requeued at the FRONT of the queue — not
 * dropped through the generic persist-failure path. The lock holder's own
 * finally block re-drains the queue.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { CONVERSATION_BUSY_MESSAGE } from "../daemon/conversation-messaging.js";
import { drainQueue } from "../daemon/conversation-process.js";
import {
  MessageQueue,
  type QueuedMessage,
} from "../daemon/conversation-queue-manager.js";

interface FakeEvent {
  type: string;
  message?: string;
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

function makeFakeConversation(options: {
  persistError?: Error;
  persistErrors?: Error[];
}) {
  const queue = new MessageQueue();
  const persistCalls: string[] = [];
  const persistErrors = options.persistErrors ?? [];
  const conversation = {
    conversationId: "conv-drain-requeue",
    queue,
    pendingSteerRepair: false,
    preactivatedSkillIds: undefined as string[] | undefined,
    messages: [] as unknown[],
    surfaceActionRequestIds: new Set<string>(),
    activeSurfaceId: undefined,
    ensureHostProxiesForTurn: async () => {},
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    getTurnChannelContext: () => null,
    setTurnChannelContext: () => {},
    getTurnInterfaceContext: () => null,
    setTurnInterfaceContext: () => {},
    emitActivityState: () => {},
    isProcessing: () => false,
    persistUserMessage: async (opts: { content: string }) => {
      persistCalls.push(opts.content);
      const err = persistErrors.shift() ?? options.persistError;
      if (err) {
        throw err;
      }
      return { id: `msg-${persistCalls.length}`, deduplicated: true };
    },
  };
  return { conversation, queue, persistCalls };
}

describe("drainQueue under processing-lock contention", () => {
  test("a busy persist requeues the message at the front instead of dropping it", async () => {
    const events: FakeEvent[] = [];
    const { conversation, queue, persistCalls } = makeFakeConversation({
      persistError: new Error(CONVERSATION_BUSY_MESSAGE),
    });
    queue.push(makeQueued("hello there", "r1", events));
    queue.push(makeQueued("and another", "r2", events));

    await drainQueue(conversation as never);

    // Exactly one persist attempt; the message is back at the head and the
    // second message was not drained past it.
    expect(persistCalls.length).toBe(1);
    expect(queue.length).toBe(2);
    expect(queue.peek(0)?.requestId).toBe("r1");
    expect(queue.peek(1)?.requestId).toBe("r2");
    // No error event reached the client — the message is not dropped.
    expect(events.filter((event) => event.type === "error")).toEqual([]);
  });

  test("a non-busy persist failure keeps the drop-and-continue behavior", async () => {
    const events: FakeEvent[] = [];
    const { conversation, queue, persistCalls } = makeFakeConversation({
      persistErrors: [new Error("disk exploded")],
    });
    queue.push(makeQueued("hello there", "r1", events));

    await drainQueue(conversation as never);

    expect(persistCalls.length).toBe(1);
    expect(queue.length).toBe(0);
    expect(
      events.filter(
        (event) => event.type === "error" && event.message === "disk exploded",
      ).length,
    ).toBe(1);
  });
});
