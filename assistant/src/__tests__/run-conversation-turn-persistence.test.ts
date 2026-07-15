import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  createConversation,
  getConversation,
} from "../persistence/conversation-crud.js";
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
// persisted before the turn runs, which is what `ensureConversationExists`
// guarantees. The persistence module is intentionally NOT mocked so the real
// `ensureConversationExists` runs against the real DB.
let lastProcessMessageConversationId: string | undefined;
mock.module("../daemon/conversation-store.js", () => ({
  getOrCreateConversation: async (conversationId: string) => ({
    abortController: undefined,
    isProcessing: () => false,
    async processMessage() {
      // The row must already exist by the time the turn persists its user
      // message — record the id so the FK precondition can be asserted.
      lastProcessMessageConversationId = conversationId;
      return "user-message-id";
    },
    enqueueMessage: () => ({ rejected: false }),
  }),
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
