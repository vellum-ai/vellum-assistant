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
 *    and cannot stand in for authorization. The caller identity is normalized
 *    exactly as the send path normalizes it before recording
 *    `sourceActorPrincipalId`, or the two disagree and a legitimate cancel is
 *    refused.
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
  return Promise.resolve(
    deleteRoute.handler({
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

describe("queued message delete: terminal event", () => {
  test("a deleted queued message publishes message_queued_deleted with its nonce", async () => {
    const { events, queue } = seedConversation("conv-delete-1", [
      { requestId: "r1", clientMessageId: "nonce-1" },
      { requestId: "r2" },
    ]);

    expect(
      await dispatchDelete({
        conversationId: "conv-delete-1",
        requestId: "r1",
      }),
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

  test("the nonce is omitted when the sender minted none", async () => {
    const { events } = seedConversation("conv-delete-2", [{ requestId: "r1" }]);

    await dispatchDelete({ conversationId: "conv-delete-2", requestId: "r1" });

    expect(events).toEqual([
      {
        type: "message_queued_deleted",
        conversationId: "conv-delete-2",
        requestId: "r1",
      },
    ]);
  });

  test("a hidden send is removed without publishing a terminal event", async () => {
    const { events, queue } = seedConversation("conv-delete-3", [
      { requestId: "r1", metadata: { hidden: true } },
    ]);

    await dispatchDelete({ conversationId: "conv-delete-3", requestId: "r1" });

    // Hidden sends never got a queued ack and render no client row, so there
    // is nothing to close out.
    expect(events).toEqual([]);
    expect(queue.length).toBe(0);
  });

  test("a delete that finds nothing publishes nothing", async () => {
    const { events, queue } = seedConversation("conv-delete-4", [
      { requestId: "r1" },
    ]);

    await expect(
      dispatchDelete({
        conversationId: "conv-delete-4",
        requestId: "r-absent",
      }),
    ).rejects.toThrow("Queued message not found");
    expect(events).toEqual([]);
    expect(queue.length).toBe(1);
  });
});

describe("queued message delete: conversation scoping", () => {
  test("a requestId from another conversation does not delete across the boundary", async () => {
    const owner = seedConversation("conv-scope-owner", [{ requestId: "r1" }]);
    const bystander = seedConversation("conv-scope-bystander", [
      { requestId: "r2" },
    ]);

    await expect(
      dispatchDelete({
        conversationId: "conv-scope-bystander",
        requestId: "r1",
      }),
    ).rejects.toThrow("Queued message not found");

    expect(owner.queue.length).toBe(1);
    expect(bystander.queue.length).toBe(1);
    expect(owner.events).toEqual([]);
    expect(bystander.events).toEqual([]);
  });

  test("an unknown conversation is reported as such, not as a missing message", async () => {
    await expect(
      dispatchDelete({ conversationId: "conv-absent", requestId: "r1" }),
    ).rejects.toThrow("Conversation not found");
  });

  test("conversationId is required", async () => {
    await expect(
      Promise.resolve(deleteRoute.handler({ pathParams: { id: "r1" } })),
    ).rejects.toThrow("Missing required parameter: conversationId");
  });
});

describe("queued message delete: actor scoping", () => {
  test("a different actor principal cannot cancel someone else's queued message", async () => {
    const { events, queue } = seedConversation("conv-actor-1", [
      { requestId: "r1", sourceActorPrincipalId: "actor-owner" },
    ]);

    await expect(
      dispatchDelete({
        conversationId: "conv-actor-1",
        requestId: "r1",
        actorPrincipalId: "actor-bystander",
      }),
    ).rejects.toThrow("sent by a different user");

    // Left intact, and no terminal event went out: the row is still pending.
    expect(queue.length).toBe(1);
    expect(events).toEqual([]);
  });

  test("the enqueuing actor principal can cancel its own queued message", async () => {
    const { events, queue } = seedConversation("conv-actor-2", [
      { requestId: "r1", sourceActorPrincipalId: "actor-owner" },
    ]);

    await dispatchDelete({
      conversationId: "conv-actor-2",
      requestId: "r1",
      actorPrincipalId: "actor-owner",
    });

    expect(queue.length).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "message_queued_deleted",
    ]);
  });

  test("a caller with no actor principal is the guardian by construction", async () => {
    const { queue } = seedConversation("conv-actor-3", [
      { requestId: "r1", sourceActorPrincipalId: "actor-owner" },
    ]);

    // Local/IPC and service principals carry no actorPrincipalId; the CLI
    // must keep being able to cancel a queued message.
    await dispatchDelete({ conversationId: "conv-actor-3", requestId: "r1" });

    expect(queue.length).toBe(0);
  });

  test("a daemon-internal enqueue with no recorded requester stays cancellable", async () => {
    const { queue } = seedConversation("conv-actor-4", [{ requestId: "r1" }]);

    // Agent wakes, subagent notifications and surface actions have no
    // enqueuing actor to compare against.
    await dispatchDelete({
      conversationId: "conv-actor-4",
      requestId: "r1",
      actorPrincipalId: "actor-bystander",
    });

    expect(queue.length).toBe(0);
  });
});

describe("queued message delete: caller identity normalization", () => {
  test("a padded principal still matches the recorded requester", async () => {
    const { queue } = seedConversation("conv-normalize-1", [
      { requestId: "r1", sourceActorPrincipalId: "actor-owner" },
    ]);

    // Sibling handlers in this layer all trim the header; without that the
    // padded value is a distinct id and the owner's own cancel 403s.
    await dispatchDelete({
      conversationId: "conv-normalize-1",
      requestId: "r1",
      actorPrincipalId: "  actor-owner  ",
    });

    expect(queue.length).toBe(0);
  });

  test("a whitespace-only principal is treated as absent, not as an id", async () => {
    const { queue } = seedConversation("conv-normalize-2", [
      { requestId: "r1", sourceActorPrincipalId: "actor-owner" },
    ]);

    await dispatchDelete({
      conversationId: "conv-normalize-2",
      requestId: "r1",
      actorPrincipalId: "   ",
    });

    expect(queue.length).toBe(0);
  });

  test("the dev-bypass principal does not 403 against a resolved guardian id", async () => {
    // Under DISABLE_HTTP_AUTH the send path stores the REAL local guardian
    // principal (`resolveActorPrincipalIdForLocalGuardian` translates the
    // synthetic `dev-bypass` before enqueue), so a delete that compared the
    // raw header would never match and every local-dev cancel would 403.
    process.env.DISABLE_HTTP_AUTH = "true";
    const { queue } = seedConversation("conv-dev-bypass", [
      { requestId: "r1", sourceActorPrincipalId: "guardian-principal-abc" },
    ]);

    await dispatchDelete({
      conversationId: "conv-dev-bypass",
      requestId: "r1",
      actorPrincipalId: "dev-bypass",
    });

    expect(queue.length).toBe(0);
  });

  test("a real principal is untouched by the dev-bypass translation", async () => {
    process.env.DISABLE_HTTP_AUTH = "true";
    const { queue } = seedConversation("conv-dev-bypass-real", [
      { requestId: "r1", sourceActorPrincipalId: "actor-owner" },
    ]);

    // Only the literal `dev-bypass` principal is translated, so auth-disabled
    // mode is not itself an authorization bypass.
    await expect(
      dispatchDelete({
        conversationId: "conv-dev-bypass-real",
        requestId: "r1",
        actorPrincipalId: "actor-bystander",
      }),
    ).rejects.toThrow("sent by a different user");

    expect(queue.length).toBe(1);
  });
});
