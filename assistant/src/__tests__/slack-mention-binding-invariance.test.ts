/**
 * Characterization: conversation binding is derived from the message's
 * source channel (`conversationExternalId`) and is invariant to any channel
 * mentioned inline in the message text (LUM-3023's canonical regression: a
 * message received in source channel A that mentions destination channel B
 * must keep the conversation, its keys, and its slackMeta bound to A; B is
 * presentation data only).
 *
 * These tests pin current behavior; nothing here changes it.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";

setConfig("memory", { enabled: false });

import { writeSlackMetadata } from "../messaging/providers/slack/message-metadata.js";
import { addMessage, getMessages } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { recordInbound } from "../persistence/delivery-crud.js";
import { conversationKeys } from "../persistence/schema/conversations.js";

await initializeDb();

const SOURCE_CHANNEL_A = "C0111SRCA";
const MENTIONED_CHANNEL_B = "C0222DESTB";

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM conversations");
}

describe("Slack mention binding invariance", () => {
  beforeEach(resetTables);

  test("a message in channel A mentioning channel B binds to A, and B mints no binding", async () => {
    // Inbound in source channel A whose text mentions destination channel B.
    const first = recordInbound("slack", SOURCE_CHANNEL_A, "1700000000.000100");
    await addMessage(
      first.conversationId,
      "user",
      JSON.stringify([
        {
          type: "text",
          text: "please post updates in #dest-channel going forward",
        },
      ]),
      {
        metadata: {
          slackMeta: writeSlackMetadata({
            source: "slack",
            channelId: SOURCE_CHANNEL_A,
            channelTs: "1700000000.000100",
            eventKind: "message",
          }),
        },
        skipIndexing: true,
      },
    );

    // A later message in the same source channel resolves to the SAME
    // conversation: the binding key is the source channel, nothing else.
    const second = recordInbound(
      "slack",
      SOURCE_CHANNEL_A,
      "1700000001.000200",
    );
    expect(second.conversationId).toBe(first.conversationId);

    // The mentioned channel B resolves to a DIFFERENT conversation if
    // anything ever arrives from it; mentioning it created no binding.
    const fromB = recordInbound(
      "slack",
      MENTIONED_CHANNEL_B,
      "1700000002.000300",
    );
    expect(fromB.conversationId).not.toBe(first.conversationId);

    // The persisted row's slackMeta records the source channel, and B
    // appears nowhere in persisted metadata, only in message text.
    const rows = getMessages(first.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toContain(SOURCE_CHANNEL_A);
    expect(rows[0].metadata).not.toContain(MENTIONED_CHANNEL_B);
  });

  test("no conversation key exists for a channel that was only ever mentioned", () => {
    recordInbound("slack", SOURCE_CHANNEL_A, "1700000003.000400");

    const keys = getDb()
      .select({ conversationKey: conversationKeys.conversationKey })
      .from(conversationKeys)
      .all();
    const keyBlob = JSON.stringify(keys);
    expect(keyBlob).toContain(SOURCE_CHANNEL_A);
    expect(keyBlob).not.toContain(MENTIONED_CHANNEL_B);
  });
});
