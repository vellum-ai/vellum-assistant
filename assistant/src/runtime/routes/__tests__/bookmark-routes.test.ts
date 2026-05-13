/**
 * Tests for the bookmark route handlers in `bookmark-routes.ts`.
 *
 * Covers:
 *   - POST + GET round-trip
 *   - POST idempotency (no duplicate row, same id returned)
 *   - POST FK validation (unknown messageId → 4xx)
 *   - DELETE /by-message/:messageId
 *   - SSE event publication on create AND delete
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Capture publish() invocations so the tests can assert on emitted events
// without spinning up real SSE infrastructure.
const publishCalls: unknown[] = [];

mock.module("../../assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async (event: unknown) => {
      publishCalls.push(event);
    },
    subscribe: () => () => {},
  },
}));

import { getDb } from "../../../memory/db-connection.js";
import { initializeDb } from "../../../memory/db-init.js";
import {
  conversations,
  messageBookmarks,
  messages,
} from "../../../memory/schema.js";
import { ROUTES as BOOKMARK_ROUTES } from "../bookmark-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = BOOKMARK_ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

const listHandler = findHandler("bookmarks_list");
const createHandler = findHandler("bookmarks_create");
const deleteByMessageHandler = findHandler("bookmarks_delete_by_message");

function clearDb(): void {
  const db = getDb();
  // Bookmarks first (FK), then messages, then conversations.
  db.delete(messageBookmarks).run();
  db.delete(messages).run();
  db.delete(conversations).run();
}

function seedConversationAndMessage(opts: {
  conversationId: string;
  messageId: string;
  conversationTitle?: string;
  messageContent?: string;
  messageRole?: string;
}): void {
  const now = Date.now();
  const db = getDb();
  db.insert(conversations)
    .values({
      id: opts.conversationId,
      title: opts.conversationTitle ?? "Test conversation",
      createdAt: now,
      updatedAt: now,
      source: "test",
      conversationType: "standard",
      memoryScopeId: "default",
    })
    .run();
  db.insert(messages)
    .values({
      id: opts.messageId,
      conversationId: opts.conversationId,
      role: opts.messageRole ?? "user",
      content: opts.messageContent ?? "hello world",
      createdAt: now,
    })
    .run();
}

async function call(
  handler: RouteDefinition["handler"],
  args: RouteHandlerArgs,
): Promise<unknown> {
  return await handler(args);
}

interface EventEnvelope {
  message: { type: string; [key: string]: unknown };
}

function publishedTypes(): string[] {
  return publishCalls.map((e) => (e as EventEnvelope).message.type);
}

beforeEach(() => {
  clearDb();
  publishCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bookmark routes", () => {
  test("POST then GET returns the new bookmark", async () => {
    seedConversationAndMessage({
      conversationId: "conv-1",
      messageId: "msg-1",
      messageContent: "first message body",
      messageRole: "assistant",
    });

    const created = (await call(createHandler, {
      body: { messageId: "msg-1", conversationId: "conv-1" },
    })) as { id: string; messageId: string; messagePreview: string };

    expect(created.messageId).toBe("msg-1");
    expect(created.messagePreview).toBe("first message body");

    const listed = (await call(listHandler, {})) as {
      bookmarks: Array<{ id: string; messageId: string }>;
    };

    expect(listed.bookmarks).toHaveLength(1);
    expect(listed.bookmarks[0]?.id).toBe(created.id);
    expect(listed.bookmarks[0]?.messageId).toBe("msg-1");
  });

  test("POST is idempotent — second call returns same id, no duplicate row", async () => {
    seedConversationAndMessage({
      conversationId: "conv-2",
      messageId: "msg-2",
    });

    const first = (await call(createHandler, {
      body: { messageId: "msg-2", conversationId: "conv-2" },
    })) as { id: string };
    const second = (await call(createHandler, {
      body: { messageId: "msg-2", conversationId: "conv-2" },
    })) as { id: string };

    expect(second.id).toBe(first.id);

    const listed = (await call(listHandler, {})) as {
      bookmarks: unknown[];
    };
    expect(listed.bookmarks).toHaveLength(1);
  });

  test("POST with non-existent messageId returns a 4xx", async () => {
    seedConversationAndMessage({
      conversationId: "conv-3",
      messageId: "msg-3",
    });

    let caught: unknown = null;
    try {
      await call(createHandler, {
        body: { messageId: "missing-msg", conversationId: "conv-3" },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    // RouteError subclasses (BadRequestError, NotFoundError, …) carry a
    // `statusCode` field that the HTTP adapter forwards to the wire — assert
    // that we throw something in the 4xx range without coupling to the
    // specific subclass.
    const statusCode = (caught as { statusCode?: number }).statusCode;
    expect(
      typeof statusCode === "number" && statusCode >= 400 && statusCode < 500,
    ).toBe(true);
  });

  test("DELETE /by-message/:messageId removes the row", async () => {
    seedConversationAndMessage({
      conversationId: "conv-5",
      messageId: "msg-5",
    });
    await call(createHandler, {
      body: { messageId: "msg-5", conversationId: "conv-5" },
    });

    const result = (await call(deleteByMessageHandler, {
      pathParams: { messageId: "msg-5" },
    })) as { success: boolean };
    expect(result.success).toBe(true);

    const listed = (await call(listHandler, {})) as { bookmarks: unknown[] };
    expect(listed.bookmarks).toHaveLength(0);
  });

  test("publishes SSE events on create AND delete", async () => {
    seedConversationAndMessage({
      conversationId: "conv-6",
      messageId: "msg-6",
    });

    const created = (await call(createHandler, {
      body: { messageId: "msg-6", conversationId: "conv-6" },
    })) as { id: string };

    // Publishes are fire-and-forget (`.catch(...)`), so let any pending
    // microtasks settle before asserting.
    await new Promise((r) => setTimeout(r, 0));

    expect(publishedTypes()).toEqual(["bookmark.created"]);
    const createdEvent = publishCalls[0] as EventEnvelope;
    expect(createdEvent.message.type).toBe("bookmark.created");
    expect(
      (createdEvent.message as unknown as { bookmark: { id: string } }).bookmark
        .id,
    ).toBe(created.id);

    publishCalls.length = 0;

    await call(deleteByMessageHandler, { pathParams: { messageId: "msg-6" } });
    await new Promise((r) => setTimeout(r, 0));

    expect(publishedTypes()).toEqual(["bookmark.deleted"]);
    const deletedEvent = publishCalls[0] as EventEnvelope;
    expect(
      (deletedEvent.message as unknown as { messageId?: string }).messageId,
    ).toBe("msg-6");
  });

  test("DELETE on a non-existent messageId does not publish", async () => {
    await call(deleteByMessageHandler, {
      pathParams: { messageId: "does-not-exist" },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(publishCalls).toHaveLength(0);
  });
});
