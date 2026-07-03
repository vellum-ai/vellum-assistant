/**
 * Tests for handleListMessages clientMessageId projection.
 *
 * Verifies that the persisted idempotency nonce is echoed back on the
 * messages snapshot row so a client can correlate its optimistic row with
 * the confirmed server row by identity instead of matching message text.
 */

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
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

interface MessagePayload {
  role: string;
  clientMessageId?: string;
}

describe("handleListMessages clientMessageId", () => {
  beforeEach(resetTables);

  test("echoes the persisted clientMessageId onto the user row", async () => {
    // GIVEN a user message persisted with a client-generated idempotency nonce
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "hello" }]),
      { clientMessageId: "nonce-abc", skipIndexing: true },
    );

    // WHEN the messages snapshot is built
    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    // THEN the snapshot row carries the nonce back for id-based correlation
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].clientMessageId).toBe("nonce-abc");
  });

  test("omits clientMessageId when the row was persisted without one", async () => {
    // GIVEN a user message persisted without a client nonce (e.g. a channel send)
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "hello" }]),
      { skipIndexing: true },
    );

    // WHEN the messages snapshot is built
    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    // THEN the field is absent rather than emitted as null/empty
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].clientMessageId).toBeUndefined();
  });
});
