/**
 * Queue-drain behavior under processing-lock contention.
 *
 * When another turn (e.g. a barged-in voice turn woken by the idle
 * transition) takes the lock between a drain's dequeue and its persist,
 * the dequeued message must be requeued at the FRONT of the queue — not
 * dropped through the generic persist-failure path. The lock holder's own
 * finally block re-drains the queue.
 */
import { describe, expect, test } from "bun:test";

import { CONVERSATION_BUSY_MESSAGE } from "../daemon/conversation-messaging.js";
import { drainQueue } from "../daemon/conversation-process.js";
import {
  MessageQueue,
  type QueuedMessage,
} from "../daemon/conversation-queue-manager.js";

interface FakeEvent {
  type: string;
  message?: string;
  conversationId?: string;
  requestId?: string;
  position?: number;
  clientMessageId?: string;
}

function makeQueued(
  content: string,
  requestId: string,
  events: FakeEvent[],
  extra?: Partial<QueuedMessage>,
): QueuedMessage {
  return {
    content,
    attachments: [],
    requestId,
    onEvent: (event: FakeEvent) => {
      events.push(event);
    },
    sentAt: Date.now(),
    ...extra,
  } as unknown as QueuedMessage;
}

function makeFakeConversation(options: {
  persistError?: Error;
  persistErrors?: Error[];
  processing?: boolean;
  pendingSteerRepair?: boolean;
}) {
  const queue = new MessageQueue();
  const persistCalls: string[] = [];
  // Every per-turn conversation mutation the drain paths perform before
  // their persist, so tests can assert an early requeue touched none of it.
  const mutationCalls: string[] = [];
  const persistErrors = options.persistErrors ?? [];
  const conversation = {
    conversationId: "conv-drain-requeue",
    queue,
    pendingSteerRepair: options.pendingSteerRepair ?? false,
    preactivatedSkillIds: undefined as string[] | undefined,
    messages: [] as unknown[],
    surfaceActionRequestIds: new Set<string>(),
    activeSurfaceId: undefined,
    ensureHostProxiesForTurn: () => {
      mutationCalls.push("ensureHostProxiesForTurn");
    },
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    getTurnChannelContext: () => null,
    setTurnChannelContext: () => {
      mutationCalls.push("setTurnChannelContext");
    },
    getTurnInterfaceContext: () => null,
    setTurnInterfaceContext: () => {
      mutationCalls.push("setTurnInterfaceContext");
    },
    setTransportHints: () => {
      mutationCalls.push("setTransportHints");
    },
    emitActivityState: () => {
      mutationCalls.push("emitActivityState");
    },
    isProcessing: () => options.processing ?? false,
    persistUserMessage: async (opts: { content: string }) => {
      persistCalls.push(opts.content);
      const err = persistErrors.shift() ?? options.persistError;
      if (err) {
        throw err;
      }
      return { id: `msg-${persistCalls.length}`, deduplicated: true };
    },
  };
  return { conversation, queue, persistCalls, mutationCalls };
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

  test("a lock already held when a single message drains requeues it without touching conversation state", async () => {
    const events: FakeEvent[] = [];
    const { conversation, queue, persistCalls, mutationCalls } =
      makeFakeConversation({ processing: true });
    queue.push(makeQueued("hello there", "r1", events));

    await drainQueue(conversation as never);

    // Requeued intact, and the drain mutated nothing: no per-turn context
    // setters, no dequeue events to the client, no persist attempt.
    expect(queue.length).toBe(1);
    expect(queue.peek(0)?.requestId).toBe("r1");
    expect(persistCalls).toEqual([]);
    expect(mutationCalls).toEqual([]);
    expect(events).toEqual([]);
    expect(conversation.preactivatedSkillIds).toBeUndefined();
  });

  test("a lock already held when a batch drains requeues it in order without touching conversation state", async () => {
    const events: FakeEvent[] = [];
    const { conversation, queue, persistCalls, mutationCalls } =
      makeFakeConversation({ processing: true });
    queue.push(makeQueued("hello there", "r1", events));
    queue.push(makeQueued("and another", "r2", events));

    await drainQueue(conversation as never);

    expect(queue.length).toBe(2);
    expect(queue.peek(0)?.requestId).toBe("r1");
    expect(queue.peek(1)?.requestId).toBe("r2");
    expect(persistCalls).toEqual([]);
    expect(mutationCalls).toEqual([]);
    expect(events).toEqual([]);
  });

  test("a steered drain requeued by the early lock check restores the steer promotion", async () => {
    const events: FakeEvent[] = [];
    const { conversation, queue, persistCalls, mutationCalls } =
      makeFakeConversation({ processing: true, pendingSteerRepair: true });
    queue.push(makeQueued("steered head", "r1", events));
    queue.push(makeQueued("queued tail", "r2", events));

    await drainQueue(conversation as never);

    // The re-drain must see pendingSteerRepair=true so it promotes the
    // steered head alone instead of batching it with the tail.
    expect(conversation.pendingSteerRepair).toBe(true);
    expect(queue.length).toBe(2);
    expect(queue.peek(0)?.requestId).toBe("r1");
    expect(queue.peek(1)?.requestId).toBe("r2");
    expect(persistCalls).toEqual([]);
    expect(mutationCalls).toEqual([]);
  });

  test("a steered drain requeued by a busy persist restores the steer promotion", async () => {
    const events: FakeEvent[] = [];
    const { conversation, queue, persistCalls } = makeFakeConversation({
      persistError: new Error(CONVERSATION_BUSY_MESSAGE),
      pendingSteerRepair: true,
    });
    queue.push(makeQueued("steered head", "r1", events));
    queue.push(makeQueued("queued tail", "r2", events));

    await drainQueue(conversation as never);

    expect(conversation.pendingSteerRepair).toBe(true);
    expect(persistCalls.length).toBe(1);
    expect(queue.length).toBe(2);
    expect(queue.peek(0)?.requestId).toBe("r1");
    expect(queue.peek(1)?.requestId).toBe("r2");
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

/**
 * The corrective `message_requeued` event.
 *
 * A drain announces `message_dequeued` before the steps that can send the
 * message back, so a client that cleared its pending indicator on that
 * announcement needs to be told the message is queued again. The rule is
 * announcement-scoped: a requeue that happens before the announcement owes
 * clients nothing, because they never stopped showing the row as queued.
 */
describe("message_requeued corrective event", () => {
  test("a busy persist tells the sender its announced message is queued again", async () => {
    const events: FakeEvent[] = [];
    const { conversation, queue } = makeFakeConversation({
      persistError: new Error(CONVERSATION_BUSY_MESSAGE),
    });
    queue.push(
      makeQueued("hello there", "r1", events, {
        clientMessageId: "nonce-1",
      }),
    );
    queue.push(makeQueued("and another", "r2", events));

    await drainQueue(conversation as never);

    expect(events.map((event) => event.type)).toEqual([
      "message_dequeued",
      "message_requeued",
    ]);
    expect(events[1]).toEqual({
      type: "message_requeued",
      conversationId: "conv-drain-requeue",
      requestId: "r1",
      // Back at the head, so 1 of the 2 visible queued items.
      position: 1,
      clientMessageId: "nonce-1",
    });
  });

  test("a requeue before the dequeue announcement stays silent", async () => {
    const events: FakeEvent[] = [];
    const { conversation, queue } = makeFakeConversation({ processing: true });
    queue.push(makeQueued("hello there", "r1", events));

    await drainQueue(conversation as never);

    // The early lock check requeues before announcing anything, so a
    // corrective event here would contradict what the client is showing.
    expect(events).toEqual([]);
    expect(queue.length).toBe(1);
  });

  test("only the batch member whose dequeue was announced is corrected", async () => {
    const headEvents: FakeEvent[] = [];
    const tailEvents: FakeEvent[] = [];
    const { conversation, queue } = makeFakeConversation({
      persistError: new Error(CONVERSATION_BUSY_MESSAGE),
    });
    queue.push(makeQueued("hello there", "r1", headEvents));
    queue.push(makeQueued("and another", "r2", tailEvents));

    await drainQueue(conversation as never);

    // The batch drain announces per member as it walks the batch, and the
    // head's busy persist ends the walk before the tail is announced.
    expect(headEvents.map((event) => event.type)).toEqual([
      "message_dequeued",
      "message_requeued",
    ]);
    expect(tailEvents).toEqual([]);
    expect(queue.peek(0)?.requestId).toBe("r1");
    expect(queue.peek(1)?.requestId).toBe("r2");
  });

  test("a hidden send is announced but never corrected", async () => {
    const events: FakeEvent[] = [];
    const { conversation, queue } = makeFakeConversation({
      persistError: new Error(CONVERSATION_BUSY_MESSAGE),
    });
    queue.push(
      makeQueued("wizard closed", "r1", events, {
        metadata: { hidden: true },
      }),
    );

    await drainQueue(conversation as never);

    // Hidden sends get no queued ack and render no client row, so there is
    // nothing for a corrective event to restore.
    expect(events.some((event) => event.type === "message_requeued")).toBe(
      false,
    );
    expect(queue.peek(0)?.requestId).toBe("r1");
  });

  test("a second contention round corrects the message again", async () => {
    const events: FakeEvent[] = [];
    const { conversation, queue } = makeFakeConversation({
      persistErrors: [
        new Error(CONVERSATION_BUSY_MESSAGE),
        new Error(CONVERSATION_BUSY_MESSAGE),
      ],
    });
    queue.push(makeQueued("hello there", "r1", events));

    await drainQueue(conversation as never);
    await drainQueue(conversation as never);

    // Each round re-announces the dequeue, so each round owes its own
    // correction: the flag settles per announcement, not once per message.
    expect(events.map((event) => event.type)).toEqual([
      "message_dequeued",
      "message_requeued",
      "message_dequeued",
      "message_requeued",
    ]);
  });
});
