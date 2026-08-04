/**
 * Tests for handleListMessages provider-error projection.
 *
 * When a turn dies on the provider-error path the agent loop persists the
 * classified error text as a synthetic assistant row stamped with
 * `metadata.messageKind: "provider_error"` (plus the classified
 * code/category). The history projection must surface that marker as the
 * wire `providerError` field, asserted against the FINAL response payload:
 * the final projection rebuilds each message object field by field, so a
 * field carried only on the intermediate object is silently dropped.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";

// Keep the memory system off so addMessage skips indexing side effects.
setConfig("memory", { enabled: false });

import { ConversationMessageSchema } from "../api/responses/conversation-message.js";
import {
  addMessage,
  createConversation,
  PROVIDER_ERROR_MESSAGE_KIND,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

interface ProjectedMessage {
  role: string;
  providerError?: { code?: string; category?: string };
}

describe("handleListMessages provider-error projection", () => {
  beforeEach(resetTables);

  test("surfaces providerError on tagged rows in the final payload", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "hello" }]),
    );
    // Mirror the agent loop's provider-error persist site: a synthetic
    // assistant row carrying the classified error, tagged in metadata.
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([
        {
          type: "text",
          text: "I couldn't reply because you ran out of credits. Add credits in Settings → Billing and we can pick up where we left off.",
        },
      ]),
      {
        metadata: {
          messageKind: PROVIDER_ERROR_MESSAGE_KIND,
          providerErrorCode: "PROVIDER_BILLING",
          providerErrorCategory: "credits_exhausted",
        },
      },
    );

    const response = (await handleListMessages({
      queryParams: { conversationId: conv.id },
    })) as { messages: ProjectedMessage[] };

    // Every projected message validates against the wire schema.
    for (const message of response.messages) {
      expect(() => ConversationMessageSchema.parse(message)).not.toThrow();
    }

    expect(response.messages).toHaveLength(2);
    const [userRow, errorRow] = response.messages;
    expect(userRow?.providerError).toBeUndefined();
    expect(errorRow?.role).toBe("assistant");
    expect(errorRow?.providerError).toEqual({
      code: "PROVIDER_BILLING",
      category: "credits_exhausted",
    });
  });

  test("coerces non-string code/category to absent fields", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "something went wrong" }]),
      {
        metadata: {
          messageKind: PROVIDER_ERROR_MESSAGE_KIND,
          providerErrorCode: 402,
          providerErrorCategory: null,
        },
      },
    );

    const response = (await handleListMessages({
      queryParams: { conversationId: conv.id },
    })) as { messages: ProjectedMessage[] };

    expect(response.messages).toHaveLength(1);
    expect(response.messages[0]?.providerError).toEqual({});
    expect(() =>
      ConversationMessageSchema.parse(response.messages[0]),
    ).not.toThrow();
  });

  test("omits providerError on untagged rows", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "hello" }]),
    );
    await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "hi there" }]),
    );

    const response = (await handleListMessages({
      queryParams: { conversationId: conv.id },
    })) as { messages: ProjectedMessage[] };

    expect(response.messages).toHaveLength(2);
    for (const message of response.messages) {
      expect(message.providerError).toBeUndefined();
      expect(() => ConversationMessageSchema.parse(message)).not.toThrow();
    }
  });
});
