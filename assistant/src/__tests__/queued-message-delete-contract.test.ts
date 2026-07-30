/**
 * Contract and authorization for deleting a queued message.
 *
 * Two things this pins:
 *
 * 1. **Terminal event.** A queued row that is cancelled never runs, so no
 *    `message_dequeued` is ever coming for it. `message_queued_deleted` is the
 *    only signal that closes it out, and it must reach the message's event
 *    sink (the hub, for HTTP sends) rather than only the caller that issued
 *    the DELETE.
 * 2. **Scoping.** The removal is scoped both ways: to the named conversation's
 *    own queue, and to the actor principal that enqueued the message. Every
 *    subscriber sees every `message_queued` ack, so requestIds are not secrets
 *    and cannot stand in for authorization.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../api/index.js";
import {
  MessageQueue,
  type QueuedMessage,
} from "../daemon/conversation-queue-manager.js";
import {
  deleteConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import { ROUTES } from "../runtime/routes/conversation-query-routes.js";

const deleteRoute = ROUTES.find(
  (route) => route.operationId === "messages_queued_delete",
)!;

const registered: string[] = [];

interface QueuedFixture {
  requestId: string;
  clientMessageId?: string;
  sourceActorPrincipalId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Register a live conversation holding `items`, and return the events its
 * queued messages publish. The delete path reads the in-memory registry and
 * touches no persistence, so a queue-only stand-in exercises the real code.
 */
function seedConversation(
  conversationId: string,
  items: QueuedFixture[],
): { events: AssistantEvent[]; queue: MessageQueue } {
  const events: AssistantEvent[] = [];
  const queue = new MessageQueue();
  for (const item of items) {
    queue.push({
      content: `content for ${item.requestId}`,
      attachments: [],
      requestId: item.requestId,
      onEvent: (event: AssistantEvent) => {
        events.push(event);
      },
      sentAt: Date.now(),
      clientMessageId: item.clientMessageId,
      sourceActorPrincipalId: item.sourceActorPrincipalId,
      metadata: item.metadata,
    } as QueuedMessage);
  }
  const conversation = {
    conversationId,
    queue,
    removeQueuedMessage: (requestId: string) =>
      queue.removeByRequestId(requestId) !== undefined,
  };
  setConversation(conversationId, conversation as never);
  registered.push(conversationId);
  return { events, queue };
}

function dispatchDelete(args: {
  conversationId: string;
  requestId: string;
  actorPrincipalId?: string;
}) {
  return deleteRoute.handler({
    pathParams: { id: args.requestId },
    queryParams: { conversationId: args.conversationId },
    headers: args.actorPrincipalId
      ? { "x-vellum-actor-principal-id": args.actorPrincipalId }
      : {},
  });
}

afterEach(() => {
  for (const conversationId of registered.splice(0)) {
    deleteConversation(conversationId);
  }
});

describe("queued message delete: terminal event", () => {
  test("a deleted queued message publishes message_queued_deleted with its nonce", () => {
    const { events, queue } = seedConversation("conv-delete-1", [
      { requestId: "r1", clientMessageId: "nonce-1" },
      { requestId: "r2" },
    ]);

    expect(
      dispatchDelete({ conversationId: "conv-delete-1", requestId: "r1" }),
    ).toEqual({ ok: true, conversationId: "conv-delete-1", requestId: "r1" });

    expect(events).toEqual([
      {
        type: "message_queued_deleted",
        conversationId: "conv-delete-1",
        requestId: "r1",
        clientMessageId: "nonce-1",
      },
    ]);
    // Only the named message left the queue.
    expect(queue.length).toBe(1);
    expect(queue.peek(0)?.requestId).toBe("r2");
  });

  test("the nonce is omitted when the sender minted none", () => {
    const { events } = seedConversation("conv-delete-2", [{ requestId: "r1" }]);

    dispatchDelete({ conversationId: "conv-delete-2", requestId: "r1" });

    expect(events).toEqual([
      {
        type: "message_queued_deleted",
        conversationId: "conv-delete-2",
        requestId: "r1",
      },
    ]);
  });

  test("a hidden send is removed without publishing a terminal event", () => {
    const { events, queue } = seedConversation("conv-delete-3", [
      { requestId: "r1", metadata: { hidden: true } },
    ]);

    dispatchDelete({ conversationId: "conv-delete-3", requestId: "r1" });

    // Hidden sends never got a queued ack and render no client row, so there
    // is nothing to close out.
    expect(events).toEqual([]);
    expect(queue.length).toBe(0);
  });

  test("a delete that finds nothing publishes nothing", () => {
    const { events, queue } = seedConversation("conv-delete-4", [
      { requestId: "r1" },
    ]);

    expect(() =>
      dispatchDelete({
        conversationId: "conv-delete-4",
        requestId: "r-absent",
      }),
    ).toThrow("Queued message not found");
    expect(events).toEqual([]);
    expect(queue.length).toBe(1);
  });
});

describe("queued message delete: conversation scoping", () => {
  test("a requestId from another conversation does not delete across the boundary", () => {
    const owner = seedConversation("conv-scope-owner", [{ requestId: "r1" }]);
    const bystander = seedConversation("conv-scope-bystander", [
      { requestId: "r2" },
    ]);

    expect(() =>
      dispatchDelete({
        conversationId: "conv-scope-bystander",
        requestId: "r1",
      }),
    ).toThrow("Queued message not found");

    expect(owner.queue.length).toBe(1);
    expect(bystander.queue.length).toBe(1);
    expect(owner.events).toEqual([]);
    expect(bystander.events).toEqual([]);
  });

  test("an unknown conversation is reported as such, not as a missing message", () => {
    expect(() =>
      dispatchDelete({ conversationId: "conv-absent", requestId: "r1" }),
    ).toThrow("Conversation not found");
  });

  test("conversationId is required", () => {
    expect(() => deleteRoute.handler({ pathParams: { id: "r1" } })).toThrow(
      "Missing required parameter: conversationId",
    );
  });
});

describe("queued message delete: actor scoping", () => {
  test("a different actor principal cannot cancel someone else's queued message", () => {
    const { events, queue } = seedConversation("conv-actor-1", [
      { requestId: "r1", sourceActorPrincipalId: "actor-owner" },
    ]);

    expect(() =>
      dispatchDelete({
        conversationId: "conv-actor-1",
        requestId: "r1",
        actorPrincipalId: "actor-bystander",
      }),
    ).toThrow("sent by a different user");

    // Left intact, and no terminal event went out: the row is still pending.
    expect(queue.length).toBe(1);
    expect(events).toEqual([]);
  });

  test("the enqueuing actor principal can cancel its own queued message", () => {
    const { events, queue } = seedConversation("conv-actor-2", [
      { requestId: "r1", sourceActorPrincipalId: "actor-owner" },
    ]);

    dispatchDelete({
      conversationId: "conv-actor-2",
      requestId: "r1",
      actorPrincipalId: "actor-owner",
    });

    expect(queue.length).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "message_queued_deleted",
    ]);
  });

  test("a caller with no actor principal is the guardian by construction", () => {
    const { queue } = seedConversation("conv-actor-3", [
      { requestId: "r1", sourceActorPrincipalId: "actor-owner" },
    ]);

    // Local/IPC and service principals carry no actorPrincipalId; the CLI
    // must keep being able to cancel a queued message.
    dispatchDelete({ conversationId: "conv-actor-3", requestId: "r1" });

    expect(queue.length).toBe(0);
  });

  test("a daemon-internal enqueue with no recorded requester stays cancellable", () => {
    const { queue } = seedConversation("conv-actor-4", [{ requestId: "r1" }]);

    // Agent wakes, subagent notifications and surface actions have no
    // enqueuing actor to compare against.
    dispatchDelete({
      conversationId: "conv-actor-4",
      requestId: "r1",
      actorPrincipalId: "actor-bystander",
    });

    expect(queue.length).toBe(0);
  });
});
