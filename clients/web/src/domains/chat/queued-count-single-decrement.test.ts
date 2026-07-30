/**
 * `pendingQueuedCount` must move exactly once per cancelled queued message.
 *
 * The counter tracks the conversation's whole queue, not this client's share
 * of it: `handleMessageQueued` increments on every `message_queued` broadcast
 * before it knows whether this client originated the send. The decrement has
 * to be symmetric, which means it belongs to the `message_queued_deleted`
 * broadcast alone. A client that also decremented locally on its own DELETE
 * response would double-count its own cancellation and drop the queued
 * indicator while other messages are still waiting.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { INITIAL_TURN_STATE, useTurnStore } from "@/domains/chat/turn-store";
import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import {
  handleMessageQueued,
  handleMessageQueuedDeleted,
} from "@/domains/chat/utils/stream-handlers/queue-handlers";
import { useConversationStore } from "@/stores/conversation-store";

/** Context wired to the REAL turn-store actions so the arithmetic is exercised. */
function ctxWithRealTurnActions(
  overrides: Parameters<typeof makeCtx>[0] = {},
) {
  return makeCtx({ turnActions: useTurnStore.getState(), ...overrides });
}

// Spy on the generated client rather than `mock.module`-ing the API surface:
// a module mock would replace `@/domains/chat/api/messages` for every other
// test file sharing this Bun process. Same convention as `api/messages.test.ts`.
let deleteCalls = 0;
const originalDelete = daemonClient.delete;

beforeEach(() => {
  deleteCalls = 0;
  daemonClient.delete = mock(async () => {
    deleteCalls += 1;
    return {
      data: { ok: true },
      error: null,
      response: new Response(null, { status: 200 }),
    };
  }) as typeof daemonClient.delete;
  useTurnStore.setState({ ...INITIAL_TURN_STATE });
  useConversationStore.setState({ activeConversationId: "conv-1" });
});

afterEach(() => {
  daemonClient.delete = originalDelete;
  useChatSessionStore.setState({ snapshot: null });
});

describe("pendingQueuedCount", () => {
  test("a cancelled message decrements once, leaving a sibling still queued", () => {
    // Two messages queued in this conversation, counted from their acks.
    useTurnStore.setState({
      phase: "queued",
      activeTurnId: "turn-1",
      pendingQueuedCount: 2,
    });

    handleMessageQueuedDeleted(
      {
        type: "message_queued_deleted",
        conversationId: "conv-1",
        requestId: "req-1",
      },
      ctxWithRealTurnActions(),
    );

    expect(useTurnStore.getState().pendingQueuedCount).toBe(1);
    // Still one message waiting, so the turn must not fall back to idle.
    expect(useTurnStore.getState().phase).toBe("queued");
  });

  test("the last cancelled message returns the turn to idle", () => {
    useTurnStore.setState({
      phase: "queued",
      activeTurnId: "turn-1",
      pendingQueuedCount: 1,
    });

    handleMessageQueuedDeleted(
      {
        type: "message_queued_deleted",
        conversationId: "conv-1",
        requestId: "req-1",
      },
      ctxWithRealTurnActions(),
    );

    expect(useTurnStore.getState().pendingQueuedCount).toBe(0);
    expect(useTurnStore.getState().phase).toBe("idle");
  });

  test("the ack-then-cancel race nets to zero without a local decrement", async () => {
    // A send whose cancel was clicked before its `message_queued` ack landed:
    // `handleMessageQueued` increments, then fires the deferred DELETE.
    handleMessageQueued(
      {
        type: "message_queued",
        conversationId: "conv-1",
        requestId: "req-1",
        position: 1,
      },
      ctxWithRealTurnActions({
        pendingQueuedMessageIds: ["stable-1"],
        pendingLocalDeletions: new Set(["stable-1"]),
      }),
    );

    expect(useTurnStore.getState().pendingQueuedCount).toBe(1);

    // Let the fire-and-forget DELETE settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(deleteCalls).toBe(1);

    // The DELETE succeeding must NOT move the count on its own; only the
    // daemon's broadcast does, and it brings the ack's increment back to 0.
    expect(useTurnStore.getState().pendingQueuedCount).toBe(1);

    handleMessageQueuedDeleted(
      {
        type: "message_queued_deleted",
        conversationId: "conv-1",
        requestId: "req-1",
      },
      ctxWithRealTurnActions(),
    );

    expect(useTurnStore.getState().pendingQueuedCount).toBe(0);
  });
});
