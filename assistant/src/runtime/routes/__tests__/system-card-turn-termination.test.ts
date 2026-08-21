/**
 * Tests which system cards terminate a turn.
 *
 * Clients treat `message_complete` as terminal: it clears the processing state
 * and closes the turn. A card that is itself the reply (a slash-command
 * result) must emit it; a card a plugin posts while a turn is still running
 * must not, or the client ends a turn that is still streaming.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../../__tests__/helpers/set-config.js";
import type { AssistantEvent } from "../../../api/index.js";

// Keep the memory system off so addMessage skips indexing side effects.
setConfig("memory", { enabled: false });

// Capture what reaches connected clients, keeping the rest of the hub's
// surface intact for the module graph's other importers.
const eventHub = await import("../../assistant-event-hub.js");
const broadcastEvents: AssistantEvent[] = [];

/** The terminal turn events among everything broadcast so far. */
function completions(): AssistantEvent[] {
  return broadcastEvents.filter((e) => e.type === "message_complete");
}

mock.module("../../assistant-event-hub.js", () => ({
  ...eventHub,
  broadcastMessage: (event: AssistantEvent) => {
    broadcastEvents.push(event);
  },
}));

const { createConversation } =
  await import("../../../persistence/conversation-crud.js");
const { initializeDb } = await import("../../../persistence/db-init.js");
const { persistSystemCard } = await import("../canned-message-complete.js");

await initializeDb();

describe("persistSystemCard turn termination", () => {
  beforeEach(() => {
    broadcastEvents.length = 0;
  });

  test("announces a card that is the reply as a completed turn", async () => {
    /**
     * Tests that a card standing in for the assistant's reply closes the turn
     * so the client stops showing it as processing.
     */

    // GIVEN a conversation
    const conv = createConversation();

    // WHEN a card that ends the turn is persisted
    const card = await persistSystemCard({
      conversationId: conv.id,
      text: "Compacted 12 messages.",
      metadata: {},
      endsTurn: true,
    });

    // THEN clients are told the turn completed, pointing at the card row
    expect(completions()).toEqual([
      {
        type: "message_complete",
        conversationId: conv.id,
        messageId: card.id,
      },
    ]);
  });

  test("leaves an in-flight turn running when a card is posted mid-turn", async () => {
    /**
     * Tests that a card written while the model is still working does not end
     * the turn in the client, which would clear processing state and let a
     * second message start while the first turn is still streaming.
     */

    // GIVEN a conversation
    const conv = createConversation();

    // WHEN a non-terminal card is persisted
    const card = await persistSystemCard({
      conversationId: conv.id,
      text: "The image you attached was not sent to the model.",
      metadata: { plugin: "image-fallback" },
      endsTurn: false,
    });

    // THEN the card is persisted
    expect(card.id).toBeTruthy();

    // AND no terminal turn event reaches clients
    expect(completions()).toEqual([]);

    // AND clients are still told to refetch the transcript so the card shows
    expect(
      broadcastEvents.some(
        (e) =>
          e.type === "sync_changed" &&
          e.tags.includes(`conversation:${conv.id}:messages`),
      ),
    ).toBe(true);
  });
});
