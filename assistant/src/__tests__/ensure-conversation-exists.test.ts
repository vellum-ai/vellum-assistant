import { beforeEach, describe, expect, test } from "bun:test";

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

    // Reports that it inserted the row so callers can emit a one-time
    // conversations-list invalidation.
    expect(ensureConversationExists(conversationId)).toBe(true);

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

    // Two extra ensures must be no-ops — return false (did not create), no
    // throw, no title/row change.
    expect(ensureConversationExists(created.id)).toBe(false);
    expect(ensureConversationExists(created.id)).toBe(false);

    const row = getConversation(created.id);
    expect(row?.id).toBe(created.id);
    expect(row?.title).toBe("already here");
  });

  test("rejects an unsafe adopted id instead of writing outside the conversations dir", () => {
    // The id becomes a path component of the on-disk conversation dir, so a
    // traversal value from an untrusted live-voice start frame must be refused
    // before createConversation() touches disk.
    for (const unsafe of ["../../tmp/x", "a/b", "..", "with space", ""]) {
      expect(() => ensureConversationExists(unsafe)).toThrow(
        /unsafe conversation id/,
      );
      expect(getConversation(unsafe)).toBeNull();
    }

    // A plain uuid-shaped id is still accepted.
    expect(
      ensureConversationExists("0f9c1e2a-3b4d-5e6f-7a8b-9c0d1e2f3a4b"),
    ).toBe(true);
  });
});
