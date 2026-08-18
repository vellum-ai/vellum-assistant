/**
 * Edit-propagation tests for Slack `message.changed` events.
 *
 * Validates that the edit intercept stage:
 *  - Updates `messages.content` and stamps `slackMeta.editedAt` when the
 *    original message can be located.
 *  - Is idempotent across successive edits (subsequent edits keep updating).
 *  - Treats missing-target edits as a silent no-op (no throw, no row change).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { readSlackMetadata } from "../messaging/providers/slack/message-metadata.js";
import { addMessage } from "../persistence/conversation-crud.js";
import { getConversationByKey } from "../persistence/conversation-key-store.js";
import { getDb, getMemoryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { linkMessage, recordInbound } from "../persistence/delivery-crud.js";
import { memoryJobs, messages } from "../persistence/schema/index.js";
import { handleEditIntercept } from "../runtime/routes/inbound-stages/edit-intercept.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM conversations");
  // memory_jobs lives in the dedicated memory connection.
  getMemoryDb()!.run("DELETE FROM memory_jobs");
}

function lexicalIndexJobMessageIds(): string[] {
  return getMemoryDb()!
    .select({ payload: memoryJobs.payload })
    .from(memoryJobs)
    .where(eq(memoryJobs.type, "index_message_lexical"))
    .all()
    .map((r) => {
      try {
        return (
          (JSON.parse(r.payload) as { messageId?: string }).messageId ?? ""
        );
      } catch {
        return "";
      }
    });
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
    { metadata: { userMessageChannel: "slack" }, skipIndexing: true },
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
      assistantId: "self",
      content: "new text",
    });

    const respJson = resp as Record<string, unknown>;
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

  // Times out on the default budget: an unresolvable target pays the full
  // `EDIT_LOOKUP_RETRIES` window before it is dropped.
  test("an edit of a message the assistant never stored creates no conversation", async () => {
    // Keying a conversation off the edit's own address made every edit of an
    // unseen message mint one, permanently titled with the loading placeholder.
    const db = getDb();
    const countRows = (table: string): number =>
      (
        db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n;

    const resp = (await handleEditIntercept({
      sourceChannel: "slack",
      conversationExternalId: "C0NEVERSEEN",
      externalMessageId: nextEditEventId(),
      sourceMessageId: "1999.0001",
      assistantId: "self",
      content: "edited text",
    })) as Record<string, unknown>;

    expect(resp.accepted).toBe(true);
    expect(resp.edited).toBe(false);
    expect(countRows("conversations")).toBe(0);
    expect(countRows("channel_inbound_events")).toBe(0);
    expect(countRows("messages")).toBe(0);
  }, 30_000);

  test("an edit records against the edited message's conversation, not a new one", async () => {
    const seeded = await seedSlackMessage({
      conversationExternalId: "C0123CHANNEL",
      channelTs: "1234.5678",
      initialContent: "original text",
    });
    const db = getDb();
    const conversationsBefore = (
      db.$client.prepare("SELECT COUNT(*) AS n FROM conversations").get() as {
        n: number;
      }
    ).n;

    await handleEditIntercept({
      sourceChannel: "slack",
      conversationExternalId: seeded.conversationExternalId,
      externalMessageId: nextEditEventId(),
      sourceMessageId: seeded.channelTs,
      assistantId: "self",
      content: "new text",
    });

    const conversationsAfter = (
      db.$client.prepare("SELECT COUNT(*) AS n FROM conversations").get() as {
        n: number;
      }
    ).n;
    expect(conversationsAfter).toBe(conversationsBefore);

    const editEvents = db.$client
      .prepare(
        `SELECT conversation_id AS conversationId FROM channel_inbound_events
         WHERE external_message_id LIKE 'edit-event-%'`,
      )
      .all() as Array<{ conversationId: string }>;
    expect(editEvents).toHaveLength(1);
    expect(editEvents[0].conversationId).toBe(seeded.conversationId);
  });

  test("a redelivered edit is answered without repeating the lookup window", async () => {
    const seeded = await seedSlackMessage({
      conversationExternalId: "C0123CHANNEL",
      channelTs: "1234.5678",
      initialContent: "original text",
    });
    const editEventId = nextEditEventId();
    const send = () =>
      handleEditIntercept({
        sourceChannel: "slack",
        conversationExternalId: seeded.conversationExternalId,
        externalMessageId: editEventId,
        sourceMessageId: seeded.channelTs,
        assistantId: "self",
        content: "new text",
      }) as Promise<Record<string, unknown>>;

    const first = await send();
    const second = await send();

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.eventId).toBe(first.eventId);
  });

  test("a threaded edit stays in the edited message's conversation and preserves thread metadata", async () => {
    const conversationExternalId = "C0123CHANNEL";
    const threadTs = "1234.0000";
    const seeded = await seedSlackMessage({
      conversationExternalId,
      channelTs: "1234.5678",
      initialContent: "original text",
    });
    const db = getDb();
    const conversationCount = (): number =>
      (
        db.$client.prepare("SELECT COUNT(*) AS n FROM conversations").get() as {
          n: number;
        }
      ).n;
    const before = conversationCount();

    const resp = await handleEditIntercept({
      sourceChannel: "slack",
      conversationExternalId,
      externalMessageId: nextEditEventId(),
      sourceMessageId: seeded.channelTs,
      sourceThreadId: threadTs,
      assistantId: "self",
      content: "new text",
    });

    expect((resp as Record<string, unknown>).accepted).toBe(true);

    // The thread id names where the reply goes, not a conversation of the
    // edit's own. Keying one off it is what minted a conversation per edit.
    const threadedKey = `asst:self:slack:${conversationExternalId}:thread:${threadTs}`;
    expect(getConversationByKey(threadedKey)).toBeNull();
    expect(conversationCount()).toBe(before);

    const after = readMessageRow(seeded.messageId);
    const outer = JSON.parse(after.metadata!) as Record<string, unknown>;
    const slackMeta = readSlackMetadata(outer.slackMeta as string);
    expect(slackMeta?.threadTs).toBe(threadTs);
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
      assistantId: "self",
      // Same text as stored -- simulates a Slack unfurl `message_changed`
      // where only attachments changed.
      content: "original text",
    });

    const respJson = resp as Record<string, unknown>;
    expect(respJson.accepted).toBe(true);
    expect(respJson.duplicate).toBe(false);
    expect(respJson.noop).toBe(true);

    const after = readMessageRow(seeded.messageId);
    expect(after.content).toBe(before.content);
    // No metadata mutation either -- the write is fully skipped.
    expect(after.metadata).toBe(before.metadata);

    // A no-op edit changes no searchable text, so it must NOT enqueue a lexical
    // reindex.
    expect(lexicalIndexJobMessageIds()).not.toContain(seeded.messageId);
  });

  test("a content-changing edit enqueues a lexical reindex for the message", async () => {
    // Regression: channel edits update the row in-place via
    // updateMessageContentAndMetadata / updateMessageContent, bypassing the
    // addMessage persist path. The lexical index must be refreshed so the old
    // Qdrant point does not go stale against the edited (FTS-updated) content.
    const seeded = await seedSlackMessage({
      conversationExternalId: "C0123CHANNEL",
      channelTs: "1234.5678",
      initialContent: "original text",
    });

    // The seed used skipIndexing, so no lexical job exists yet.
    expect(lexicalIndexJobMessageIds()).not.toContain(seeded.messageId);

    await handleEditIntercept({
      sourceChannel: "slack",
      conversationExternalId: seeded.conversationExternalId,
      externalMessageId: nextEditEventId(),
      sourceMessageId: seeded.channelTs,
      assistantId: "self",
      content: "edited searchable text",
    });

    expect(readMessageRow(seeded.messageId).content).toBe(
      "edited searchable text",
    );
    // The edit reindexed the message into the lexical index.
    expect(lexicalIndexJobMessageIds()).toContain(seeded.messageId);
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
      assistantId: "self",
      content: "new text",
    });

    const respJson = resp as Record<string, unknown>;
    expect(respJson.accepted).toBe(true);
    expect(respJson.duplicate).toBe(false);

    const afterUnknown = readMessageRow(seeded.messageId);
    expect(afterUnknown.content).toBe(beforeUnknown.content);
    expect(afterUnknown.metadata).toBe(beforeUnknown.metadata);
  }, 30_000);
});
