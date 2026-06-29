import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
  conversationMetadataSyncTag,
  SYNC_TAGS,
} from "../daemon/message-types/sync.js";
import {
  projectAssistantMessage,
  recordConversationSeenSignal,
} from "../persistence/conversation-attention-store.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { ROUTES as CONVERSATION_LIST_ROUTES } from "../runtime/routes/conversation-list-routes.js";
import { ROUTES as CONVERSATION_MANAGEMENT_ROUTES } from "../runtime/routes/conversation-management-routes.js";
import type { RouteDefinition } from "../runtime/routes/types.js";
import { publishConversationTitleChanged } from "../runtime/sync/resource-sync-events.js";
import { resetDbForTesting } from "./db-test-helpers.js";
import { waitFor } from "./helpers/wait-for.js";

await initializeDb();

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
    resetDbForTesting();
  });

  test("rename emits the typed title event and a metadata-only sync tag (no list umbrella)", async () => {
    // Rename is a content-only change: the row stays in place, the list
    // shape is unchanged, only the title field flips. Web patches the
    // single cached row via the typed `conversation_title_updated` event
    // (`patchConversation` in `metadata-handlers.ts`) and the per-
    // conversation `sync_changed` metadata tag is included as a belt-and-
    // suspenders signal for sibling-tab consumers that missed the typed
    // event. The legacy `conversation_list_invalidated` broadcast is
    // scoped to `targetInterfaceId: "macos"` and therefore not visible to
    // this process-type subscriber.
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
    }, 2);

    expect(received.map((event) => event.message.type)).toEqual([
      "conversation_title_updated",
      "sync_changed",
    ]);
    expect(received[1]!.message).toEqual({
      type: "sync_changed",
      tags: [conversationMetadataSyncTag(conversation.id)],
    });
    // Defense-in-depth: the umbrella `conversationsList` tag would force
    // web to redrain the full paginated list — we deliberately omit it
    // for content-only reasons.
    expect((received[1]!.message as { tags: string[] }).tags).not.toContain(
      SYNC_TAGS.conversationsList,
    );
    // The legacy invalidation broadcast is macOS-scoped and must not
    // reach this process-type subscriber.
    expect(
      received.some(
        (event) => event.message.type === "conversation_list_invalidated",
      ),
    ).toBe(false);
  });

  test("auto-title generation emits the typed title event and a metadata-only sync tag (no list umbrella)", async () => {
    // Auto-title generation (first-pass on prompt submit, second-pass
    // regeneration, bootstrap, and voice) persists via the title service and
    // broadcasts through `publishConversationTitleChanged` — the same helper
    // the rename route uses. Like a rename, generation is content-only: the
    // row stays in place and only the title flips, so web patches the cached
    // row from the typed `conversation_title_updated` event and the per-
    // conversation metadata tag is the belt-and-suspenders signal. The list
    // umbrella is deliberately omitted so web never redrains the paginated
    // list for a title change.
    const conversation = createConversation("Generating…");

    const received = await captureEvents(() => {
      publishConversationTitleChanged(conversation.id, "Generated title");
    }, 2);

    expect(received.map((event) => event.message.type)).toEqual([
      "conversation_title_updated",
      "sync_changed",
    ]);
    expect(received[1]!.message).toEqual({
      type: "sync_changed",
      tags: [conversationMetadataSyncTag(conversation.id)],
    });
    expect((received[1]!.message as { tags: string[] }).tags).not.toContain(
      SYNC_TAGS.conversationsList,
    );
  });

  test("create emits a sync_changed with the conversationsList umbrella tag", async () => {
    // Create is shape-changing — a row is added to the paginated list,
    // so web must redrain the list (cannot patch a row it has never
    // fetched). The umbrella `conversationsList` tag is the signal for
    // that redrain. Per-conversation metadata is included so any future
    // single-row consumer can patch the freshly added row in place
    // without an extra GET. The legacy macOS-only invalidation broadcast
    // is not visible to process subscribers.
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
    }, 1);

    expect(conversationId).toBeDefined();
    expect(received.map((event) => event.message.type)).toEqual([
      "sync_changed",
    ]);
    expect(received[0]!.message).toEqual({
      type: "sync_changed",
      tags: [
        SYNC_TAGS.conversationsList,
        conversationMetadataSyncTag(conversationId!),
      ],
    });
    expect(
      received.some(
        (event) => event.message.type === "conversation_list_invalidated",
      ),
    ).toBe(false);
  });

  test("reorder emits a sync_changed with the umbrella tag and per-conversation metadata tags", async () => {
    // Reorder changes the row position in the paginated list — also
    // shape-changing. The umbrella `conversationsList` tag forces a
    // redrain so the new ordering shows. Per-conversation metadata tags
    // are bundled in to give any single-row consumer a hint that the
    // touched conversations' positions have moved (currently web
    // consumes only the umbrella tag; metadata tags are forward-compat).
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
    }, 1);

    expect(received.map((event) => event.message.type)).toEqual([
      "sync_changed",
    ]);
    expect(received[0]!.message).toEqual({
      type: "sync_changed",
      tags: [
        SYNC_TAGS.conversationsList,
        conversationMetadataSyncTag(first.id),
        conversationMetadataSyncTag(second.id),
      ],
    });
    expect(
      received.some(
        (event) => event.message.type === "conversation_list_invalidated",
      ),
    ).toBe(false);
  });

  test("record seen emits only a per-conversation metadata sync tag (no list umbrella)", async () => {
    // Seen state is per-conversation attention metadata, not list-
    // shaped. The old behavior emitted `sync_changed` carrying the
    // umbrella `conversationsList` tag, which forced every subscribed
    // web client to redrain the full paginated sidebar on every
    // conversation switch that landed on an unseen conversation (~14
    // requests at ~300 conversations). The current behavior emits a
    // single `sync_changed` with only the per-conversation
    // `conversation:<id>:metadata` tag, which web consumes by GET-and-
    // patching the single cached row via `refreshConversationRow`.
    //
    // The legacy `conversation_list_invalidated` broadcast is still
    // emitted for macOS (which has no per-row patcher) but is scoped
    // to `targetInterfaceId: "macos"` and therefore not visible to
    // this process-type subscriber.
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
    }, 1);

    expect(received.map((event) => event.message.type)).toEqual([
      "sync_changed",
    ]);
    expect(received[0]!.message).toEqual({
      type: "sync_changed",
      tags: [conversationMetadataSyncTag(conversation.id)],
    });
    // Defense-in-depth: the umbrella `conversationsList` tag would
    // force the very paginated-list drain this redesign exists to
    // avoid. It must not appear here.
    expect((received[0]!.message as { tags: string[] }).tags).not.toContain(
      SYNC_TAGS.conversationsList,
    );
    expect(
      received.some(
        (event) => event.message.type === "conversation_list_invalidated",
      ),
    ).toBe(false);
  });

  test("mark unread emits only a per-conversation metadata sync tag (no list umbrella)", async () => {
    // Symmetric with `record seen`: mark-unread flips the per-conversation
    // hasUnseen flag back to true. Same per-conversation sync tag, same
    // absence of list-level fan-out.
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
    }, 1);

    expect(received.map((event) => event.message.type)).toEqual([
      "sync_changed",
    ]);
    expect(received[0]!.message).toEqual({
      type: "sync_changed",
      tags: [conversationMetadataSyncTag(conversation.id)],
    });
    expect((received[0]!.message as { tags: string[] }).tags).not.toContain(
      SYNC_TAGS.conversationsList,
    );
    expect(
      received.some(
        (event) => event.message.type === "conversation_list_invalidated",
      ),
    ).toBe(false);
  });

  test("addMessage('assistant') emits a metadata sync tag when attention state transitions", async () => {
    // When an assistant message transitions a conversation from seen to
    // unseen, `addMessage` emits `conversation:<id>:metadata` so the web
    // sidebar picks up the attention state change without a full list
    // refetch. This is the fix for LUM-1907: background processes that
    // add assistant messages (notification delivery, proactive artifacts)
    // now automatically notify clients.
    const conversation = createConversation("Attention sync");

    const received = await captureEvents(async () => {
      await addMessage(
        conversation.id,
        "assistant",
        JSON.stringify([{ type: "text", text: "hello" }]),
      );
    }, 1);

    expect(received.map((event) => event.message.type)).toEqual([
      "sync_changed",
    ]);
    expect(received[0]!.message).toEqual({
      type: "sync_changed",
      tags: [conversationMetadataSyncTag(conversation.id)],
    });
  });

  test("addMessage('assistant') does not emit a metadata sync tag when already unseen", async () => {
    // When the conversation is already unseen (attention cursor was
    // already past the seen cursor), a subsequent assistant message
    // should NOT emit a metadata tag — no state transition occurred.
    const conversation = createConversation("Already unseen");
    await addMessage(
      conversation.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "first" }]),
    );

    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });
    try {
      await addMessage(
        conversation.id,
        "assistant",
        JSON.stringify([{ type: "text", text: "second" }]),
      );
      // Brief wait to ensure no event is emitted
      await new Promise((resolve) => setTimeout(resolve, 50));
      const metadataEvents = received.filter(
        (event) =>
          event.message.type === "sync_changed" &&
          (event.message as { tags: string[] }).tags.some((tag: string) =>
            tag.includes(":metadata"),
          ),
      );
      expect(metadataEvents).toHaveLength(0);
    } finally {
      subscription.dispose();
    }
  });

  test("addMessage('user') does not emit a metadata sync tag", async () => {
    // User messages never affect attention state — only assistant
    // messages advance the attention cursor via projectAssistantMessage.
    const conversation = createConversation("User message");

    const received: AssistantEvent[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      callback: (event) => {
        received.push(event);
      },
    });
    try {
      await addMessage(
        conversation.id,
        "user",
        JSON.stringify([{ type: "text", text: "hello" }]),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const metadataEvents = received.filter(
        (event) =>
          event.message.type === "sync_changed" &&
          (event.message as { tags: string[] }).tags.some((tag: string) =>
            tag.includes(":metadata"),
          ),
      );
      expect(metadataEvents).toHaveLength(0);
    } finally {
      subscription.dispose();
    }
  });
});
