import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  createConversation,
  ensureConversationExists,
  getConversation,
} from "../persistence/conversation-crud.js";
import {
  isEchoSuppressedUserMessage,
  isReplyPushIneligibleUserMessage,
} from "../persistence/conversation-types.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

// Capture the list-invalidation calls `runConversationTurn` fires when it
// creates a brand-new conversation row, without pulling in the real sync
// publisher (which reaches for live SSE subscribers).
const listChangedCalls: Array<{ kind: string; conversationId: string }> = [];
mock.module("../runtime/sync/resource-sync-events.js", () => ({
  publishConversationListAndMetadataChanged: (
    kind: string,
    conversationId: string,
  ) => {
    listChangedCalls.push({ kind, conversationId });
  },
}));

// Stub the heavy machinery: the in-memory conversation build (provider wiring,
// system prompt, history hydration) and the SSE event fan-out. The agent turn
// itself is a no-op — this test only asserts that the `conversations` row is
// persisted before the turn runs. The real `getOrCreateConversation` now
// creates the DB row before hydrating, so the mock mirrors that by calling
// `ensureConversationExists`. The persistence module is intentionally NOT
// mocked so the real `ensureConversationExists` runs against the real DB.
let lastProcessMessageConversationId: string | undefined;
let lastProcessMessageOptions: Record<string, unknown> | undefined;
let lastEnqueueOptions: Record<string, unknown> | undefined;
let conversationIsProcessing = false;
mock.module("../daemon/conversation-store.js", () => ({
  getOrCreateConversation: async (
    conversationId: string,
    options?: { conversationType?: string },
  ) => {
    if (!getConversation(conversationId)) {
      if (options?.conversationType) {
        createConversation({
          id: conversationId,
          conversationType: options.conversationType as
            | "standard"
            | "background",
        });
      } else {
        ensureConversationExists(conversationId);
      }
    }
    return {
      abortController: undefined,
      isProcessing: () => conversationIsProcessing,
      async processMessage(processOptions: Record<string, unknown>) {
        // The row must already exist by the time the turn persists its user
        // message — record the id so the FK precondition can be asserted.
        lastProcessMessageConversationId = conversationId;
        lastProcessMessageOptions = processOptions;
        return "user-message-id";
      },
      enqueueMessage: (enqueueOptions: Record<string, unknown>) => {
        lastEnqueueOptions = enqueueOptions;
        return { rejected: false };
      },
    };
  },
}));

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: () => {},
}));

mock.module("../providers/media-resolve.js", () => ({
  resolveMediaSourceData: () => null,
}));

// Import under test AFTER the mocks are registered so its dynamic imports
// resolve to the stubs above.
const { runConversationTurn } =
  await import("../plugin-api/conversation-turn.js");

describe("runConversationTurn persistence", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    listChangedCalls.length = 0;
    lastProcessMessageConversationId = undefined;
    lastProcessMessageOptions = undefined;
    lastEnqueueOptions = undefined;
    conversationIsProcessing = false;
  });

  test("persists a conversations row for a freshly-minted conversation", async () => {
    const result = await runConversationTurn({
      content: [{ type: "text", text: "hello" }],
    });

    // The row exists on disk — not just as an in-memory Conversation object —
    // so the user-message persist inside the turn has its FK target.
    const row = getConversation(result.conversationId);
    expect(row?.id).toBe(result.conversationId);
    expect(lastProcessMessageConversationId).toBe(result.conversationId);

    // Siblings/sidebars are told about the new conversation, mirroring the
    // send-message route.
    expect(listChangedCalls).toEqual([
      { kind: "created", conversationId: result.conversationId },
    ]);
  });

  test("adopts a caller-supplied conversation id verbatim when no row exists", async () => {
    const conversationId = "0f9c1e2a-3b4d-5e6f-7a8b-9c0d1e2f3a4b";

    const result = await runConversationTurn({
      conversationId,
      content: [{ type: "text", text: "hello" }],
    });

    expect(result.conversationId).toBe(conversationId);
    expect(getConversation(conversationId)?.id).toBe(conversationId);
    expect(listChangedCalls).toEqual([{ kind: "created", conversationId }]);
  });

  test("is a no-op for an already-persisted conversation row", async () => {
    const existing = createConversation({ title: "already here" });
    listChangedCalls.length = 0;

    const result = await runConversationTurn({
      conversationId: existing.id,
      content: [{ type: "text", text: "follow up" }],
    });

    expect(result.conversationId).toBe(existing.id);
    // Row is untouched and no duplicate "created" invalidation fires.
    expect(getConversation(existing.id)?.title).toBe("already here");
    expect(listChangedCalls).toEqual([]);
  });
});

// A plugin drives its turn on its own schedule, so the row that opens it is
// machine-initiated even when the turn runs in an ordinary standard
// conversation the user also types into. Each case asserts the shared
// eligibility predicate's verdict on the stamped metadata, so the marker and
// the gate that reads it cannot drift apart.
describe("runConversationTurn provenance", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    lastProcessMessageOptions = undefined;
    lastEnqueueOptions = undefined;
    conversationIsProcessing = false;
  });

  test("stamps the initiating row automated so its reply raises no push", async () => {
    const existing = createConversation({ title: "standard conversation" });

    await runConversationTurn({
      conversationId: existing.id,
      content: [{ type: "text", text: "transcript excerpt" }],
    });

    const metadata = lastProcessMessageOptions?.metadata as Record<
      string,
      unknown
    >;
    expect(metadata).toEqual({ automated: true });
    expect(isReplyPushIneligibleUserMessage(metadata)).toBe(true);
    // Not an echo-suppression marker: the row still renders in the transcript.
    expect(isEchoSuppressedUserMessage(metadata)).toBe(false);
  });

  test("stamps the same marker on a turn queued behind a busy conversation", async () => {
    const existing = createConversation({ title: "busy conversation" });
    conversationIsProcessing = true;

    const result = await runConversationTurn({
      conversationId: existing.id,
      content: [{ type: "text", text: "transcript excerpt" }],
    });

    expect(result.queued).toBe(true);
    const metadata = lastEnqueueOptions?.metadata as Record<string, unknown>;
    expect(metadata).toEqual({ automated: true });
    expect(isReplyPushIneligibleUserMessage(metadata)).toBe(true);
  });
});
