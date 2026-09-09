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
  NO_RESPONSE_MESSAGE_KIND,
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
  noResponse?: boolean;
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

  test("projects noResponse from the deliberate-silence marker", async () => {
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "thanks!" }]),
    );
    // Mirror the agent loop's turn-boundary stamp: the row keeps the raw
    // sentinel as content and carries the marker in metadata.
    const silent = await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "<no_response/>" }]),
      { metadata: { messageKind: NO_RESPONSE_MESSAGE_KIND } },
    );

    const response = (await handleListMessages({
      queryParams: { conversationId: conv.id },
    })) as { messages: ProjectedMessage[] };

    for (const message of response.messages) {
      expect(() => ConversationMessageSchema.parse(message)).not.toThrow();
    }

    const silentRow = response.messages.find((m) => m.id === silent.id);
    expect(silentRow?.noResponse).toBe(true);
  });

  test("projects a reaction's typed emoji fields to the response", async () => {
    const conv = createConversation();
    const row = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "[reaction]" }]),
      {
        metadata: {
          messageKind: "reaction",
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: "chan-1",
            eventKind: "reaction",
            reaction: {
              targetMessageId: "555.1",
              emoji: "<:party_blob:111>",
              emojiKind: "custom",
              emojiName: "party_blob",
              emojiId: "111",
              emojiAnimated: true,
              op: "added",
            },
          }),
        },
      },
    );

    const response = (await handleListMessages({
      queryParams: { conversationId: conv.id },
    })) as {
      messages: Array<
        ProjectedMessage & {
          reaction?: {
            emoji: string;
            emojiKind?: string;
            emojiName?: string;
            emojiId?: string;
            emojiAnimated?: boolean;
          };
        }
      >;
    };
    const projected = response.messages.find((m) => m.id === row.id);
    expect(projected?.reaction).toMatchObject({
      emoji: "<:party_blob:111>",
      emojiKind: "custom",
      emojiName: "party_blob",
      emojiId: "111",
      emojiAnimated: true,
    });
  });

  test("projects the reaction fact from a reaction row's envelope", async () => {
    const conv = createConversation();
    const row = await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "[reaction]" }]),
      {
        metadata: {
          messageKind: "reaction",
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: "chan-1",
            eventKind: "reaction",
            reaction: {
              targetMessageId: "555.1",
              emoji: "🎉",
              op: "added",
            },
          }),
        },
      },
    );

    const response = (await handleListMessages({
      queryParams: { conversationId: conv.id },
    })) as {
      messages: Array<
        ProjectedMessage & {
          reaction?: { emoji: string; selfAuthored?: boolean };
        }
      >;
    };
    for (const message of response.messages) {
      expect(() => ConversationMessageSchema.parse(message)).not.toThrow();
    }
    const projected = response.messages.find((m) => m.id === row.id);
    expect(projected?.reaction?.emoji).toBe("🎉");
    expect(projected?.reaction?.selfAuthored).toBe(true);
  });

  test("projects deletedAt from a row deleted on its channel", async () => {
    // Mirror the delete propagation stamp: the row keeps its content and the
    // envelope carries the marker, in either shape the daemon writes.
    const conv = createConversation();
    const discordRow = await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "A message later deleted" }]),
      {
        metadata: {
          providerMeta: JSON.stringify({
            source: "discord",
            conversationExternalId: "chan-1",
            messageId: "111",
            eventKind: "message",
            deletedAt: 1725100000000,
          }),
        },
      },
    );
    const slackRow = await addMessage(
      conv.id,
      "assistant",
      JSON.stringify([{ type: "text", text: "The assistant's deleted post" }]),
      {
        metadata: {
          slackMeta: JSON.stringify({
            source: "slack",
            channelId: "C0123",
            channelTs: "1725100000.000100",
            eventKind: "message",
            deletedAt: 1725100001000,
          }),
        },
      },
    );

    const response = (await handleListMessages({
      queryParams: { conversationId: conv.id },
    })) as { messages: Array<ProjectedMessage & { deletedAt?: number }> };
    for (const message of response.messages) {
      expect(() => ConversationMessageSchema.parse(message)).not.toThrow();
    }
    expect(
      response.messages.find((m) => m.id === discordRow.id)?.deletedAt,
    ).toBe(1725100000000);
    expect(response.messages.find((m) => m.id === slackRow.id)?.deletedAt).toBe(
      1725100001000,
    );
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
