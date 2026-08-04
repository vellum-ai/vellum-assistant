/**
 * Tests for handleListMessages system-card projection.
 *
 * Daemon-authored status cards (the /compact, /clean, and summarize-up-to
 * result cards persisted via `persistCannedAssistantCard`) are stamped
 * `messageKind: "system_card"`. The history projection must surface the
 * `systemCard` flag so clients render them as standalone system notices
 * instead of assistant-persona speech after a reload.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";

// Keep the memory system off so addMessage skips indexing side effects.
setConfig("memory", { enabled: false });

import { ConversationMessageSchema } from "../api/responses/conversation-message.js";
import {
  addMessage,
  createConversation,
  SYSTEM_CARD_MESSAGE_KIND,
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
  id: string;
  role: string;
  systemCard?: boolean;
}

describe("handleListMessages system-card projection", () => {
  beforeEach(resetTables);

  test("projects systemCard from the persisted card row metadata", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "/compact" }]),
    );
    // Mirror persistCannedAssistantCard: an assistant row stamped with the
    // system-card marker.
    const card = await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "Compacted 12 messages." }]),
      { metadata: { messageKind: SYSTEM_CARD_MESSAGE_KIND } },
    );

    const response = (await handleListMessages({
      queryParams: { conversationId: conv.id },
    })) as { messages: ProjectedMessage[] };

    // Every projected message validates against the wire schema.
    for (const message of response.messages) {
      expect(() => ConversationMessageSchema.parse(message)).not.toThrow();
    }

    const cardRow = response.messages.find((m) => m.id === card.id);
    expect(cardRow).toBeDefined();
    expect(cardRow?.systemCard).toBe(true);
  });

  test("omits systemCard on ordinary user and assistant rows", async () => {
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
      expect(message.systemCard).toBeUndefined();
      expect(() => ConversationMessageSchema.parse(message)).not.toThrow();
    }
  });
});
