/**
 * Edit-propagation tests for Slack `message.changed` events.
 *
 * Validates that the edit intercept stage:
 *  - Updates `messages.content` and stamps `slackMeta.editedAt` when the
 *    original message can be located.
 *  - Is idempotent across successive edits (subsequent edits keep updating).
 *  - Treats missing-target edits as a silent no-op (no throw, no row change).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { addMessage } from "../memory/conversation-crud.js";
import { getDb, initializeDb } from "../memory/db.js";
import { linkMessage, recordInbound } from "../memory/delivery-crud.js";
import { messages } from "../memory/schema.js";
import { readSlackMetadata } from "../messaging/providers/slack/message-metadata.js";
import { handleEditIntercept } from "../runtime/routes/inbound-stages/edit-intercept.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM conversations");
}

interface SeededFixture {
  conversationId: string;
  messageId: string;
  channelTs: string;
  conversationExternalId: string;
}

/**
 * Seed a Slack message in a fresh conversation. Mirrors what the new-message
 * pipeline does at runtime: `recordInbound` writes the channel_inbound_events
 * row (storing `sourceMessageId = ts`), `addMessage` writes the user message,
 * and `linkMessage` connects them so edit lookups succeed.
 *
 * Note: the gateway sets `externalMessageId = client_msg_id ?? ts` for new
 * Slack messages, so this fixture mirrors a message where `client_msg_id`
 * equals the `ts` (i.e. the simplest case). The lookup mechanism keys on
 * `sourceMessageId`, which always carries the `ts`, so the test exercises
 * the same path that production hits regardless of `client_msg_id` presence.
 */
async function seedSlackMessage(opts: {
  conversationExternalId: string;
  channelTs: string;
  initialContent: string;
}): Promise<SeededFixture> {
  const { conversationExternalId, channelTs, initialContent } = opts;

  const inboundResult = recordInbound(
    "slack",
    conversationExternalId,
    channelTs,
    {
      sourceMessageId: channelTs,
    },
  );

  const inserted = await addMessage(
    inboundResult.conversationId,
    "user",
    initialContent,
    { userMessageChannel: "slack" },
    { skipIndexing: true },
  );

  linkMessage(inboundResult.eventId, inserted.id);

  return {
    conversationId: inboundResult.conversationId,
    messageId: inserted.id,
    channelTs,
    conversationExternalId,
  };
}

function readMessageRow(messageId: string): {
  content: string;
  metadata: string | null;
} {
  const db = getDb();
  const row = db
    .select({ content: messages.content, metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  if (!row) {
    throw new Error(`message ${messageId} not found`);
  }
  return { content: row.content, metadata: row.metadata };
}

let editEventCounter = 0;
function nextEditEventId(): string {
  editEventCounter += 1;
  return `edit-event-${Date.now()}-${editEventCounter}`;
}

describe("Slack edit propagation", () => {
  beforeEach(() => {
    resetTables();
    editEventCounter = 0;
  });

  test("updates content and stamps slackMeta.editedAt when original is found", async () => {
    const seeded = await seedSlackMessage({
      conversationExternalId: "C0123CHANNEL",
      channelTs: "1234.5678",
      initialContent: "original text",
    });

    const before = readMessageRow(seeded.messageId);
    expect(before.content).toBe("original text");

    const t0 = Date.now();
    const resp = await handleEditIntercept({
      sourceChannel: "slack",
      conversationExternalId: seeded.conversationExternalId,
      externalMessageId: nextEditEventId(),
      sourceMessageId: seeded.channelTs,
      canonicalAssistantId: "self",
      assistantId: "self",
      content: "new text",
    });

    expect(resp.status).toBe(200);
    const respJson = (await resp.json()) as Record<string, unknown>;
    expect(respJson.accepted).toBe(true);
    expect(respJson.duplicate).toBe(false);

    const after = readMessageRow(seeded.messageId);
    expect(after.content).toBe("new text");

    expect(after.metadata).not.toBeNull();
    const outer = JSON.parse(after.metadata!);
    expect(outer.userMessageChannel).toBe("slack");
    expect(typeof outer.slackMeta).toBe("string");

    const slackMeta = readSlackMetadata(outer.slackMeta);
    expect(slackMeta).not.toBeNull();
    expect(slackMeta!.source).toBe("slack");
    expect(slackMeta!.channelId).toBe(seeded.conversationExternalId);
    expect(slackMeta!.channelTs).toBe(seeded.channelTs);
    expect(slackMeta!.eventKind).toBe("message");
    expect(typeof slackMeta!.editedAt).toBe("number");
    expect(slackMeta!.editedAt!).toBeGreaterThanOrEqual(t0);
  });

  test("is idempotent across successive edits", async () => {
    const seeded = await seedSlackMessage({
      conversationExternalId: "C0123CHANNEL",
      channelTs: "1234.5678",
      initialContent: "original text",
    });

    await handleEditIntercept({
      sourceChannel: "slack",
      conversationExternalId: seeded.conversationExternalId,
      externalMessageId: nextEditEventId(),
      sourceMessageId: seeded.channelTs,
      canonicalAssistantId: "self",
      assistantId: "self",
      content: "first edit",
    });

    const afterFirst = readMessageRow(seeded.messageId);
    expect(afterFirst.content).toBe("first edit");
    const firstSlackMeta = readSlackMetadata(
      (JSON.parse(afterFirst.metadata!) as Record<string, unknown>)
        .slackMeta as string | null,
    );
    expect(firstSlackMeta).not.toBeNull();
    const firstEditedAt = firstSlackMeta!.editedAt!;

    // Ensure the second edit's timestamp is observably after the first so the
    // assertion below proves the field was re-stamped, not stale.
    await Bun.sleep(2);

    await handleEditIntercept({
      sourceChannel: "slack",
      conversationExternalId: seeded.conversationExternalId,
      externalMessageId: nextEditEventId(),
      sourceMessageId: seeded.channelTs,
      canonicalAssistantId: "self",
      assistantId: "self",
      content: "second edit",
    });

    const afterSecond = readMessageRow(seeded.messageId);
    expect(afterSecond.content).toBe("second edit");
    const secondSlackMeta = readSlackMetadata(
      (JSON.parse(afterSecond.metadata!) as Record<string, unknown>)
        .slackMeta as string | null,
    );
    expect(secondSlackMeta).not.toBeNull();
    expect(secondSlackMeta!.editedAt!).toBeGreaterThan(firstEditedAt);
    // Other fields stay stable across edits.
    expect(secondSlackMeta!.channelId).toBe(seeded.conversationExternalId);
    expect(secondSlackMeta!.channelTs).toBe(seeded.channelTs);
    expect(secondSlackMeta!.eventKind).toBe("message");
  });

  test("no-op edit (identical text, e.g. unfurl) skips DB write", async () => {
    const seeded = await seedSlackMessage({
      conversationExternalId: "C0123CHANNEL",
      channelTs: "1234.5678",
      initialContent: "original text",
    });

    const before = readMessageRow(seeded.messageId);

    const resp = await handleEditIntercept({
      sourceChannel: "slack",
      conversationExternalId: seeded.conversationExternalId,
      externalMessageId: nextEditEventId(),
      sourceMessageId: seeded.channelTs,
      canonicalAssistantId: "self",
      assistantId: "self",
      // Same text as stored -- simulates a Slack unfurl `message_changed`
      // where only attachments changed.
      content: "original text",
    });

    expect(resp.status).toBe(200);
    const respJson = (await resp.json()) as Record<string, unknown>;
    expect(respJson.accepted).toBe(true);
    expect(respJson.duplicate).toBe(false);
    expect(respJson.noop).toBe(true);

    const after = readMessageRow(seeded.messageId);
    expect(after.content).toBe(before.content);
    // No metadata mutation either -- the write is fully skipped.
    expect(after.metadata).toBe(before.metadata);
  });

  // The lookup retries 5 times with 2s backoff (~10s total) before giving up,
  // so this test legitimately needs to outrun the default 5s per-test timeout.
  test("missing-target edit is a no-op (no throw, no row changed)", async () => {
    const seeded = await seedSlackMessage({
      conversationExternalId: "C0123CHANNEL",
      channelTs: "1234.5678",
      initialContent: "original text",
    });
    const beforeUnknown = readMessageRow(seeded.messageId);

    const resp = await handleEditIntercept({
      sourceChannel: "slack",
      conversationExternalId: seeded.conversationExternalId,
      // sourceMessageId points at a ts that was never stored.
      externalMessageId: nextEditEventId(),
      sourceMessageId: "9999.0000",
      canonicalAssistantId: "self",
      assistantId: "self",
      content: "new text",
    });

    expect(resp.status).toBe(200);
    const respJson = (await resp.json()) as Record<string, unknown>;
    expect(respJson.accepted).toBe(true);
    expect(respJson.duplicate).toBe(false);

    const afterUnknown = readMessageRow(seeded.messageId);
    expect(afterUnknown.content).toBe(beforeUnknown.content);
    expect(afterUnknown.metadata).toBe(beforeUnknown.metadata);
  }, 30_000);
});
