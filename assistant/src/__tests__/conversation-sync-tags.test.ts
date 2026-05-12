import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  conversationMetadataSyncTag,
  SYNC_TAGS,
} from "../daemon/message-types/sync.js";
import {
  projectAssistantMessage,
  recordConversationSeenSignal,
} from "../memory/conversation-attention-store.js";
import { createConversation } from "../memory/conversation-crud.js";
import { getDb, resetDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { ROUTES as CONVERSATION_LIST_ROUTES } from "../runtime/routes/conversation-list-routes.js";
import { ROUTES as CONVERSATION_MANAGEMENT_ROUTES } from "../runtime/routes/conversation-management-routes.js";
import type { RouteDefinition } from "../runtime/routes/types.js";
import { waitFor } from "./helpers/wait-for.js";

initializeDb();

function clearTables(): void {
  const db = getDb();
  db.run("DELETE FROM conversation_assistant_attention_state");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function findRoute(
  routes: RouteDefinition[],
  operationId: string,
): RouteDefinition {
  const route = routes.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route;
}

async function captureEvents(
  action: () => void | Promise<unknown>,
  expectedCount: number,
): Promise<AssistantEvent[]> {
  const received: AssistantEvent[] = [];
  const subscription = assistantEventHub.subscribe({
    type: "process",
    callback: (event) => {
      received.push(event);
    },
  });
  try {
    await action();
    await waitFor(() => received.length >= expectedCount, {
      message: "Timed out waiting for conversation sync tag event",
    });
    return received;
  } finally {
    subscription.dispose();
  }
}

describe("conversation sync tags", () => {
  beforeEach(() => {
    clearTables();
  });

  afterAll(() => {
    resetDb();
  });

  test("rename emits legacy title/list events and conversation metadata sync tags", async () => {
    const conversation = createConversation("Old title");
    const route = findRoute(
      CONVERSATION_MANAGEMENT_ROUTES,
      "renameConversation",
    );

    const received = await captureEvents(() => {
      route.handler({
        pathParams: { id: conversation.id },
        body: { name: "New title" },
      });
    }, 3);

    expect(received.map((event) => event.message.type)).toEqual([
      "conversation_title_updated",
      "conversation_list_invalidated",
      "sync_changed",
    ]);
    expect(received[2]!.message).toEqual({
      type: "sync_changed",
      tags: [
        SYNC_TAGS.conversationsList,
        conversationMetadataSyncTag(conversation.id),
      ],
    });
  });

  test("create emits legacy list invalidation and list/metadata sync tags", async () => {
    const route = findRoute(
      CONVERSATION_MANAGEMENT_ROUTES,
      "createConversation",
    );
    let conversationId: string | undefined;

    const received = await captureEvents(async () => {
      const result = (await route.handler({
        body: { conversationKey: "sync-create-test" },
      })) as { id: string };
      conversationId = result.id;
    }, 2);

    expect(conversationId).toBeDefined();
    expect(received.map((event) => event.message.type)).toEqual([
      "conversation_list_invalidated",
      "sync_changed",
    ]);
    expect(received[1]!.message).toEqual({
      type: "sync_changed",
      tags: [
        SYNC_TAGS.conversationsList,
        conversationMetadataSyncTag(conversationId!),
      ],
    });
  });

  test("reorder emits list invalidation and metadata sync tags for touched conversations", async () => {
    const first = createConversation("First");
    const second = createConversation("Second");
    const route = findRoute(
      CONVERSATION_MANAGEMENT_ROUTES,
      "reorderConversations",
    );

    const received = await captureEvents(() => {
      route.handler({
        body: {
          updates: [
            { conversationId: first.id, displayOrder: 1, isPinned: true },
            { conversationId: second.id, displayOrder: 2, isPinned: false },
          ],
        },
      });
    }, 2);

    expect(received.map((event) => event.message.type)).toEqual([
      "conversation_list_invalidated",
      "sync_changed",
    ]);
    expect(received[1]!.message).toEqual({
      type: "sync_changed",
      tags: [
        SYNC_TAGS.conversationsList,
        conversationMetadataSyncTag(first.id),
        conversationMetadataSyncTag(second.id),
      ],
    });
  });

  test("record seen emits list invalidation and metadata sync tags for the touched conversation", async () => {
    const conversation = createConversation("Attention");
    projectAssistantMessage({
      conversationId: conversation.id,
      messageId: "assistant-message-1",
      messageAt: 1_700_000_000_000,
    });
    const route = findRoute(CONVERSATION_LIST_ROUTES, "recordConversationSeen");

    const received = await captureEvents(() => {
      route.handler({
        body: {
          conversationId: conversation.id,
          sourceChannel: "vellum",
          signalType: "macos_conversation_opened",
          confidence: "explicit",
          source: "test",
        },
      });
    }, 2);

    expect(received.map((event) => event.message.type)).toEqual([
      "conversation_list_invalidated",
      "sync_changed",
    ]);
    expect(received[1]!.message).toEqual({
      type: "sync_changed",
      tags: [
        SYNC_TAGS.conversationsList,
        conversationMetadataSyncTag(conversation.id),
      ],
    });
  });

  test("mark unread emits list invalidation and metadata sync tags for the touched conversation", async () => {
    const conversation = createConversation("Attention");
    projectAssistantMessage({
      conversationId: conversation.id,
      messageId: "assistant-message-1",
      messageAt: 1_700_000_000_000,
    });
    recordConversationSeenSignal({
      conversationId: conversation.id,
      sourceChannel: "vellum",
      signalType: "macos_conversation_opened",
      confidence: "explicit",
      source: "test",
    });
    const route = findRoute(CONVERSATION_LIST_ROUTES, "markConversationUnread");

    const received = await captureEvents(() => {
      route.handler({
        body: {
          conversationId: conversation.id,
        },
      });
    }, 2);

    expect(received.map((event) => event.message.type)).toEqual([
      "conversation_list_invalidated",
      "sync_changed",
    ]);
    expect(received[1]!.message).toEqual({
      type: "sync_changed",
      tags: [
        SYNC_TAGS.conversationsList,
        conversationMetadataSyncTag(conversation.id),
      ],
    });
  });
});
