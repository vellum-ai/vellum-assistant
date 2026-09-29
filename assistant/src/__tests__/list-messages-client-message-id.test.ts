/**
 * Tests for handleListMessages clientMessageId projection.
 *
 * Verifies that the persisted idempotency nonce is echoed back on the
 * messages snapshot row so a client can correlate its optimistic row with
 * the confirmed server row by identity instead of matching message text.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { MESSAGE_KEYS } from "../i18n/index.js";
import { setConfig } from "./helpers/set-config.js";

// Keep the memory system off so addMessage skips indexing side effects.
setConfig("memory", { enabled: false });

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
  textSegments?: string[];
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
    const response = await handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    // THEN the snapshot row carries the nonce back for id-based correlation
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].clientMessageId).toBe("nonce-abc");
  });

  test("localizes persisted assistant keys without rewriting legacy text", async () => {
    const localizedConv = createConversation();
    await addMessage(
      localizedConv.id,
      "assistant",
      JSON.stringify([
        {
          type: "text",
          text: MESSAGE_KEYS.AGENT_LOOP_UNPARSEABLE_TOOL_RETRY_STOP,
        },
      ]),
      { skipIndexing: true },
    );

    const localizedResponse = await handleListMessages({
      queryParams: { conversationId: localizedConv.id },
      headers: { "accept-language": "es" },
    });
    const localizedBody = localizedResponse as { messages: MessagePayload[] };
    expect(localizedBody.messages[0]?.textSegments).toEqual([
      "Me detuve después de varias llamadas de herramienta con formato incorrecto para evitar que esta conversación creciera indefinidamente. Inténtalo de nuevo o cambia de modelo si el problema continúa.",
    ]);

    const legacyConv = createConversation();
    const legacy =
      "I stopped after repeated malformed tool calls to keep this conversation from growing indefinitely. Please try again, or switch models if the problem continues.";
    await addMessage(
      legacyConv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: legacy }]),
      { skipIndexing: true },
    );

    const legacyResponse = await handleListMessages({
      queryParams: { conversationId: legacyConv.id },
      headers: { "accept-language": "es" },
    });
    const legacyBody = legacyResponse as { messages: MessagePayload[] };
    expect(legacyBody.messages[0]?.textSegments).toEqual([legacy]);
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
    const response = await handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    // THEN the field is absent rather than emitted as null/empty
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].clientMessageId).toBeUndefined();
  });
});
