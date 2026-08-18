import { beforeEach, describe, expect, test } from "bun:test";

import type { ChannelId } from "../../channels/types.js";
import {
  ensureConversationExists,
  getConversation,
} from "../../persistence/conversation-crud.js";
import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { classifyWorkOrigin } from "../work-origin.js";

await initializeDb();

/**
 * A person messaging the assistant over Slack or Telegram is waiting on the
 * reply exactly like a person typing in the app, so the spend is interactive.
 * The classifier reads that off `conversation_type` and `source`, which the
 * channel adoption path leaves at their defaults. These tests pin both the
 * persisted values and the bucket they produce, so a change to channel
 * conversation creation fails here instead of silently reclassifying a
 * waiting user as background work.
 */
describe("work origin of channel conversations", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  });

  const channels: Array<{ id: string; origin: ChannelId }> = [
    { id: "conv-slack-1", origin: "slack" },
    { id: "conv-telegram-1", origin: "telegram" },
  ];

  for (const { id, origin } of channels) {
    test(`a ${origin} conversation is a standard user conversation`, () => {
      expect(ensureConversationExists(id, origin)).toBe(true);

      const row = getConversation(id);
      expect(row?.conversationType).toBe("standard");
      expect(row?.source).toBe("user");
      expect(row?.originChannel).toBe(origin);
    });

    test(`a ${origin} conversation classifies as user_interactive`, () => {
      ensureConversationExists(id, origin);

      const row = getConversation(id);
      expect(
        classifyWorkOrigin({
          conversationType: row?.conversationType ?? null,
          conversationSource: row?.source ?? null,
          callSite: null,
          parentConversationId: null,
        }),
      ).toBe("user_interactive");
    });
  }
});
