/**
 * Authorization for steering to a queued message.
 *
 * Steering aborts the in-flight generation and promotes the named queued
 * message to the head of the queue, so it is scoped to the actor principal
 * that enqueued the message the same way deletion is: every subscriber sees
 * every `message_queued` ack, so requestIds are not secrets and cannot stand
 * in for authorization. The caller identity is normalized exactly as the send
 * path normalizes it before recording `sourceActorPrincipalId`.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  MessageQueue,
  type QueuedMessage,
} from "../daemon/conversation-queue-manager.js";
import {
  deleteConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import { ROUTES } from "../runtime/routes/conversation-query-routes.js";

const steerRoute = ROUTES.find(
  (route) => route.operationId === "messages_queued_steer",
)!;

const registered: string[] = [];

interface QueuedFixture {
  requestId: string;
  sourceActorPrincipalId?: string;
}

/**
 * Register a live, mid-turn conversation holding `items`. The steer path
 * reads the in-memory registry and touches no persistence, so a queue-only
 * stand-in exercises the real code.
 */
function seedProcessingConversation(
  conversationId: string,
  items: QueuedFixture[],
): { queue: MessageQueue; aborted: () => boolean } {
  const queue = new MessageQueue();
  for (const item of items) {
    queue.push({
      content: `content for ${item.requestId}`,
      attachments: [],
      requestId: item.requestId,
      onEvent: () => {},
      sentAt: Date.now(),
      sourceActorPrincipalId: item.sourceActorPrincipalId,
    } as QueuedMessage);
  }
  const abortController = new AbortController();
  const conversation = {
    conversationId,
    queue,
    isProcessing: () => true,
    pendingSteerRepair: false,
    abortController,
    denyAllPendingConfirmations: () => {},
  };
  setConversation(conversationId, conversation as never);
  registered.push(conversationId);
  return { queue, aborted: () => abortController.signal.aborted };
}

function dispatchSteer(args: {
  conversationId: string;
  requestId: string;
  actorPrincipalId?: string;
}) {
  return Promise.resolve(
    steerRoute.handler({
      pathParams: { id: args.requestId },
      queryParams: { conversationId: args.conversationId },
      headers:
        args.actorPrincipalId !== undefined
          ? { "x-vellum-actor-principal-id": args.actorPrincipalId }
          : {},
    }),
  );
}

afterEach(() => {
  for (const conversationId of registered.splice(0)) {
    deleteConversation(conversationId);
  }
  delete process.env.DISABLE_HTTP_AUTH;
});

describe("queued message steer: actor scoping", () => {
  test("a different actor principal cannot steer to someone else's queued message", async () => {
    const { queue, aborted } = seedProcessingConversation("conv-steer-1", [
      { requestId: "r-head", sourceActorPrincipalId: "actor-owner" },
      { requestId: "r-target", sourceActorPrincipalId: "actor-owner" },
    ]);

    await expect(
      dispatchSteer({
        conversationId: "conv-steer-1",
        requestId: "r-target",
        actorPrincipalId: "actor-bystander",
      }),
    ).rejects.toThrow("sent by a different user");

    // The queue order is untouched and the live generation kept running.
    expect(queue.peek(0)?.requestId).toBe("r-head");
    expect(aborted()).toBe(false);
  });

  test("the enqueuing actor principal can steer to its own queued message", async () => {
    const { queue, aborted } = seedProcessingConversation("conv-steer-2", [
      { requestId: "r-head", sourceActorPrincipalId: "actor-owner" },
      { requestId: "r-target", sourceActorPrincipalId: "actor-owner" },
    ]);

    expect(
      await dispatchSteer({
        conversationId: "conv-steer-2",
        requestId: "r-target",
        actorPrincipalId: "actor-owner",
      }),
    ).toEqual({
      ok: true,
      conversationId: "conv-steer-2",
      requestId: "r-target",
    });

    expect(queue.peek(0)?.requestId).toBe("r-target");
    expect(aborted()).toBe(true);
  });

  test("a caller with no actor principal is the guardian by construction", async () => {
    const { queue } = seedProcessingConversation("conv-steer-3", [
      { requestId: "r-head", sourceActorPrincipalId: "actor-owner" },
      { requestId: "r-target", sourceActorPrincipalId: "actor-owner" },
    ]);

    // Local/IPC and service principals carry no actorPrincipalId; the CLI
    // must keep being able to steer.
    await dispatchSteer({
      conversationId: "conv-steer-3",
      requestId: "r-target",
    });

    expect(queue.peek(0)?.requestId).toBe("r-target");
  });

  test("a daemon-internal enqueue with no recorded requester stays steerable", async () => {
    const { queue } = seedProcessingConversation("conv-steer-4", [
      { requestId: "r-head" },
      { requestId: "r-target" },
    ]);

    await dispatchSteer({
      conversationId: "conv-steer-4",
      requestId: "r-target",
      actorPrincipalId: "actor-anyone",
    });

    expect(queue.peek(0)?.requestId).toBe("r-target");
  });
});
