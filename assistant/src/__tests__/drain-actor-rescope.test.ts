/**
 * A queued turn runs as its own sender, against that sender's history.
 *
 * History is scoped to the conversation's resting actor: `loadFromDb` splices
 * persisted personal-memory blocks into the transcript only for actors allowed
 * to see them. A queued message is frequently not from whoever the previous
 * turn ran as, so the drain has to stamp the sender and re-scope before the
 * turn reads that history. Without it a contact's queued turn inherits the
 * guardian's view, and the reply can reflect the guardian's personal memory
 * back to them.
 */
import { describe, expect, test } from "bun:test";

import { drainQueue } from "../daemon/conversation-process.js";
import {
  MessageQueue,
  type QueuedMessage,
} from "../daemon/conversation-queue-manager.js";
import type { TrustContext } from "../daemon/trust-context-types.js";

const GUARDIAN: TrustContext = {
  trustClass: "guardian",
  sourceChannel: "vellum",
};
// Non-guardian, so `isPersonalMemoryAllowed` is false for it while it is true
// for the guardian: the exact axis `loadFromDb` gates memory blocks on.
const CONTACT: TrustContext = {
  trustClass: "unverified_contact",
  sourceChannel: "slack",
};

function makeQueued(
  content: string,
  requestId: string,
  trustContext?: TrustContext,
): QueuedMessage {
  return {
    content,
    attachments: [],
    requestId,
    onEvent: () => {},
    sentAt: Date.now(),
    ...(trustContext ? { trustContext } : {}),
  } as unknown as QueuedMessage;
}

function makeFakeConversation(restingTrust: TrustContext) {
  const queue = new MessageQueue();
  // Ordered, because "re-scoped" only means anything if it happened before the
  // turn read the history.
  const calls: string[] = [];
  const conversation = {
    conversationId: "conv-drain-rescope",
    queue,
    pendingSteerRepair: false,
    preactivatedSkillIds: undefined as string[] | undefined,
    messages: [] as unknown[],
    surfaceActionRequestIds: new Set<string>(),
    activeSurfaceId: undefined,
    trustContext: restingTrust,
    currentTurnTrustContext: undefined as TrustContext | undefined,
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    ensureHostProxiesForTurn: () => {},
    getTurnChannelContext: () => null,
    setTurnChannelContext: () => {},
    getTurnInterfaceContext: () => null,
    setTurnInterfaceContext: () => {},
    setTransportHints: () => {},
    emitActivityState: () => {},
    isProcessing: () => false,
    setTrustContext: (ctx: TrustContext | null) => {
      calls.push(`setTrustContext:${ctx?.trustClass}`);
      conversation.trustContext = ctx as TrustContext;
    },
    ensureActorScopedHistory: async () => {
      calls.push(
        `ensureActorScopedHistory:${conversation.trustContext?.trustClass}`,
      );
    },
    persistUserMessage: async (opts: { content: string }) => {
      calls.push(`persistUserMessage:${opts.content}`);
      return { id: "msg-1", deduplicated: true };
    },
  };
  return { conversation, queue, calls };
}

describe("queued turns re-scope history to their own sender", () => {
  test("a contact's message queued behind a guardian turn re-scopes before the turn reads history", async () => {
    const { conversation, queue, calls } = makeFakeConversation(GUARDIAN);
    queue.push(makeQueued("what did we decide?", "r1", CONTACT));

    await drainQueue(conversation as never);

    // The sender is stamped, history is re-scoped under that stamp, and only
    // then does the turn persist. Asserting the order is the point: re-scoping
    // after the read would leave the guardian's memory blocks in the
    // transcript this turn runs against.
    expect(calls).toEqual([
      "setTrustContext:unverified_contact",
      "ensureActorScopedHistory:unverified_contact",
      "persistUserMessage:what did we decide?",
    ]);
    // The resting actor now names whoever the running turn belongs to.
    expect(conversation.trustContext).toEqual(CONTACT);
    expect(conversation.currentTurnTrustContext).toEqual(CONTACT);
  });

  test("a same-actor queue still re-scopes, which the conversation resolves to a no-op", async () => {
    const { conversation, queue, calls } = makeFakeConversation(GUARDIAN);
    queue.push(makeQueued("and another thing", "r1", GUARDIAN));

    await drainQueue(conversation as never);

    expect(calls).toEqual([
      "setTrustContext:guardian",
      "ensureActorScopedHistory:guardian",
      "persistUserMessage:and another thing",
    ]);
    expect(conversation.trustContext).toEqual(GUARDIAN);
  });

  test("a queued message with no trust of its own leaves the resting actor in place", async () => {
    const { conversation, queue, calls } = makeFakeConversation(GUARDIAN);
    queue.push(makeQueued("internal dispatch", "r1"));

    await drainQueue(conversation as never);

    // No stamp: nothing claimed this message for a different actor, so the
    // owner stands rather than being overwritten with a guess.
    expect(calls).toEqual([
      "ensureActorScopedHistory:guardian",
      "persistUserMessage:internal dispatch",
    ]);
    expect(conversation.trustContext).toEqual(GUARDIAN);
  });
});
