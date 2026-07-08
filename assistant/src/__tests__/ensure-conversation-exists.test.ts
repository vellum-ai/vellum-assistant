import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

import {
  addMessage,
  createConversation,
  ensureConversationExists,
  getConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

describe("ensureConversationExists", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  });

  test("adopts the given id so a first message persists without an FK error", async () => {
    // Regression (JARVIS-1259): the live-voice first turn of a new chat adopts
    // an unpersisted client conversation id. Persisting the user message before
    // the row exists tripped `FOREIGN KEY constraint failed`.
    const conversationId = "brand-new-live-voice-conversation";

    ensureConversationExists(conversationId);

    const row = getConversation(conversationId);
    expect(row?.id).toBe(conversationId);

    // The FK target now exists, so the user-message insert succeeds.
    const message = await addMessage(
      conversationId,
      "user",
      "hello from voice",
      {
        skipIndexing: true,
      },
    );
    expect(message.conversationId).toBe(conversationId);
  });

  test("is idempotent and never clobbers an existing conversation", () => {
    const created = createConversation({ title: "already here" });

    // Two extra ensures must be no-ops — no throw, no title/row change.
    ensureConversationExists(created.id);
    ensureConversationExists(created.id);

    const row = getConversation(created.id);
    expect(row?.id).toBe(created.id);
    expect(row?.title).toBe("already here");
  });
});
