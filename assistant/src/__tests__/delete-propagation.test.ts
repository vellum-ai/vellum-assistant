/**
 * Tests for delete propagation into stored messages.
 *
 * The gateway forwards delete events with `eventKind: "delete"` and
 * `sourceMetadata.messageId` set to the deleted message's ts. The daemon
 * marks the corresponding stored row's `slackMeta.deletedAt` while leaving
 * the `content` column untouched (audit retention; the renderer elides based
 * on the deletedAt marker).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { readProviderMetadata } from "../messaging/read-provider-metadata.js";

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

import { eq } from "drizzle-orm";

import {
  readSlackMetadata,
  writeSlackMetadata,
} from "../messaging/providers/slack/message-metadata.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { linkMessage, recordInbound } from "../persistence/delivery-crud.js";
import { messages } from "../persistence/schema/index.js";
import { _setDeleteLookupConfigForTests } from "../runtime/routes/inbound-message-handler.js";
import {
  handleChannelInbound,
  seedContactChannel,
} from "./helpers/channel-test-adapter.js";

await initializeDb();

const TEST_BEARER_TOKEN = "test-token";
// Slack `message_deleted` events stamp the deleted message's original author
// as the actor (gateway: `event.previous_message.user`). The author must be a
// recognised member for the inbound ACL to admit the event — gating delete
// behind ACL is the contract under test.
const SLACK_DELETE_ACTOR_ID = "U_DELETE_ACTOR";
const SLACK_DELETE_ACTOR_DISPLAY_NAME = "Delete Actor";

function resetState(): void {
  const db = getDb();
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
}

function seedActiveDeleteActor(externalChatId: string): void {
  seedContactChannel({
    sourceChannel: "slack",
    externalUserId: SLACK_DELETE_ACTOR_ID,
    externalChatId,
    status: "active",
    policy: "allow",
    displayName: SLACK_DELETE_ACTOR_DISPLAY_NAME,
  });
}

interface SeededMessage {
  conversationId: string;
  messageId: string;
  originalTs: string;
  externalChatId: string;
}

function seedSlackMessage(opts: {
  externalChatId: string;
  originalTs: string;
  content?: string;
  withSlackMeta?: boolean;
}): SeededMessage {
  const db = getDb();
  // Record the inbound event so channel_inbound_events has an entry
  // (sourceMessageId = ts for the lookup join).
  const inbound = recordInbound("slack", opts.externalChatId, opts.originalTs, {
    sourceMessageId: opts.originalTs,
  });

  const messageId = `msg-${opts.originalTs}`;
  const slackMeta = opts.withSlackMeta
    ? writeSlackMetadata({
        source: "slack",
        channelId: opts.externalChatId,
        channelTs: opts.originalTs,
        eventKind: "message",
        displayName: "Test User",
      })
    : undefined;
  const metadata = slackMeta
    ? JSON.stringify({
        userMessageChannel: "slack",
        userMessageInterface: "slack",
        slackMeta,
      })
    : JSON.stringify({
        userMessageChannel: "slack",
        userMessageInterface: "slack",
      });

  db.insert(messages)
    .values({
      id: messageId,
      conversationId: inbound.conversationId,
      role: "user",
      content: opts.content ?? "Original message text",
      createdAt: Date.now(),
      metadata,
    })
    .run();
  linkMessage(inbound.eventId, messageId);

  return {
    conversationId: inbound.conversationId,
    messageId,
    originalTs: opts.originalTs,
    externalChatId: opts.externalChatId,
  };
}

function buildSlackDeleteRequest(opts: {
  externalChatId: string;
  deletedTs: string;
  eventId?: string;
  actorExternalId?: string;
}): Request {
  const eventId = opts.eventId ?? `evt-del-${opts.deletedTs}`;
  return new Request("http://localhost:8080/channels/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Origin": TEST_BEARER_TOKEN,
    },
    body: JSON.stringify({
      sourceChannel: "slack",
      interface: "slack",
      conversationExternalId: opts.externalChatId,
      // Delete events get a fresh externalMessageId per-event (PR 5).
      externalMessageId: eventId,
      content: "",
      callbackData: "message_deleted",
      actorExternalId: opts.actorExternalId ?? SLACK_DELETE_ACTOR_ID,
      sourceMetadata: {
        // The original (deleted) message's ts — the lookup key.
        messageId: opts.deletedTs,
      },
    }),
  });
}

describe("Discord delete propagation (unattributed)", () => {
  beforeEach(() => {
    resetState();
    _setDeleteLookupConfigForTests(2, 20);
  });

  test("an unattributed delete applies only to an ingested row, without ACL identity", async () => {
    // Discord's MESSAGE_DELETE names no actor, so the gateway forwards the
    // synthetic discord-system id with actorUnattributed stated. No member
    // exists for that id and no trust verdict rides the event; the delete
    // still applies, because the original's author cleared the ACL when the
    // message arrived and the stamp touches only that ingested row.
    const chatId = "999888777666555444";
    const originalId = "111222333444555001";
    const inbound = recordInbound("discord", chatId, originalId, {
      sourceMessageId: originalId,
    });
    const messageId = `msg-${originalId}`;
    getDb()
      .insert(messages)
      .values({
        id: messageId,
        conversationId: inbound.conversationId,
        role: "user",
        content: "A message someone later deleted",
        metadata: JSON.stringify({ userMessageChannel: "discord" }),
        createdAt: Date.now(),
      })
      .run();
    linkMessage(inbound.eventId, messageId);

    const req = new Request("http://localhost:8080/channels/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Origin": TEST_BEARER_TOKEN,
      },
      body: JSON.stringify({
        sourceChannel: "discord",
        interface: "discord",
        conversationExternalId: chatId,
        externalMessageId: `${originalId}:delete`,
        eventKind: "delete",
        content: "",
        actorExternalId: "discord-system",
        sourceMetadata: {
          messageId: originalId,
          actorUnattributed: true,
        },
      }),
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(true);

    const row = getDb()
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .get();
    expect(row!.content).toBe("A message someone later deleted");
    const neutral = readProviderMetadata(row!.metadata);
    expect(neutral).not.toBeNull();
    expect(neutral!.source).toBe("discord");
    expect(neutral!.deletedAt).toBeDefined();
  });

  test("an unattributed delete for a never-ingested message is a no-op", async () => {
    const req = new Request("http://localhost:8080/channels/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Origin": TEST_BEARER_TOKEN,
      },
      body: JSON.stringify({
        sourceChannel: "discord",
        interface: "discord",
        conversationExternalId: "999888777666555444",
        externalMessageId: "111222333444555002:delete",
        eventKind: "delete",
        content: "",
        actorExternalId: "discord-system",
        sourceMetadata: {
          messageId: "111222333444555002",
          actorUnattributed: true,
        },
      }),
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(false);
  });
});

describe("Slack delete propagation", () => {
  beforeEach(() => {
    resetState();
    seedActiveDeleteActor("C0123CHANNEL");
    // Keep the lookup retry-loop fast by default so the "no such message"
    // paths don't pay the full production backoff. The race-test below
    // overrides this to a longer delay so the first retry can observe
    // the deferred linkMessage.
    _setDeleteLookupConfigForTests(2, 20);
  });

  test("marks slackMeta.deletedAt and leaves content untouched", async () => {
    const seeded = seedSlackMessage({
      externalChatId: "C0123CHANNEL",
      originalTs: "1234.5678",
      content: "Original audited text",
      withSlackMeta: true,
    });

    const before = Date.now();
    const req = buildSlackDeleteRequest({
      externalChatId: seeded.externalChatId,
      deletedTs: seeded.originalTs,
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;
    const after = Date.now();

    expect(resp.status).toBe(200);
    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(true);
    expect(json.messageId).toBe(seeded.messageId);

    const db = getDb();
    const row = db
      .select()
      .from(messages)
      .where(eq(messages.id, seeded.messageId))
      .get();

    expect(row).toBeDefined();
    // Content column MUST be unchanged for audit.
    expect(row!.content).toBe("Original audited text");

    // Parent metadata still has its sibling keys intact.
    const parsed = JSON.parse(row!.metadata!) as Record<string, unknown>;
    expect(parsed.userMessageChannel).toBe("slack");
    expect(parsed.userMessageInterface).toBe("slack");
    expect(typeof parsed.slackMeta).toBe("string");

    // slackMeta.deletedAt is set to a recent timestamp.
    const slackMeta = readSlackMetadata(parsed.slackMeta as string);
    expect(slackMeta).not.toBeNull();
    expect(slackMeta!.deletedAt).toBeDefined();
    expect(slackMeta!.deletedAt!).toBeGreaterThanOrEqual(before);
    expect(slackMeta!.deletedAt!).toBeLessThanOrEqual(after);
    // Existing slackMeta fields are preserved.
    expect(slackMeta!.channelId).toBe("C0123CHANNEL");
    expect(slackMeta!.channelTs).toBe("1234.5678");
    expect(slackMeta!.eventKind).toBe("message");
    expect(slackMeta!.displayName).toBe("Test User");
  });

  test("delete for unknown ts is a no-op", async () => {
    // Seed an unrelated message so the conversation exists but ts mismatches.
    const seeded = seedSlackMessage({
      externalChatId: "C0123CHANNEL",
      originalTs: "1111.1111",
      content: "Should remain untouched",
      withSlackMeta: true,
    });

    const req = buildSlackDeleteRequest({
      externalChatId: seeded.externalChatId,
      deletedTs: "9999.9999", // not seeded
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(resp.status).toBe(200);
    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(false);

    // Original message must not be modified.
    const db = getDb();
    const row = db
      .select()
      .from(messages)
      .where(eq(messages.id, seeded.messageId))
      .get();

    expect(row!.content).toBe("Should remain untouched");
    const parsed = JSON.parse(row!.metadata!) as Record<string, unknown>;
    const slackMeta = readSlackMetadata(parsed.slackMeta as string);
    expect(slackMeta!.deletedAt).toBeUndefined();
  });

  test("a never-ingested delete returns without paying the retry window", async () => {
    // The retry loop exists for one race: an inbound-event row written
    // before its message link lands. No row at all means nothing can appear
    // by waiting, and the wait would hold the conversation's serialized
    // forward lane for every unrelated delete a busy room produces.
    _setDeleteLookupConfigForTests(2, 500);
    const started = Date.now();
    const req = buildSlackDeleteRequest({
      externalChatId: "C0123CHANNEL",
      deletedTs: "0000.0000",
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(false);
    // Far under a single 500ms retry delay: the loop short-circuited.
    expect(Date.now() - started).toBeLessThan(400);
  });

  test("delete for row without slackMeta stamps the neutral metadata", async () => {
    // A legacy pre-enrichment row still gets its delete marked: the neutral
    // envelope is synthesized so readProviderMetadata serves the stamp to
    // every channel-agnostic reader, and content stays for audit.
    const seeded = seedSlackMessage({
      externalChatId: "C0123CHANNEL",
      originalTs: "2222.2222",
      content: "Legacy pre-upgrade text",
      withSlackMeta: false,
    });

    const before = Date.now();
    const req = buildSlackDeleteRequest({
      externalChatId: seeded.externalChatId,
      deletedTs: seeded.originalTs,
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(true);

    const db = getDb();
    const row = db
      .select()
      .from(messages)
      .where(eq(messages.id, seeded.messageId))
      .get();

    expect(row!.content).toBe("Legacy pre-upgrade text");
    const parsed = JSON.parse(row!.metadata!) as Record<string, unknown>;
    expect(parsed.slackMeta).toBeUndefined();
    const neutral = readProviderMetadata(row!.metadata);
    expect(neutral).not.toBeNull();
    expect(neutral!.source).toBe("slack");
    expect(neutral!.messageId).toBe(seeded.originalTs);
    expect(neutral!.deletedAt).toBeDefined();
    expect(neutral!.deletedAt!).toBeGreaterThanOrEqual(before);
  });

  test("a flat-legacy row's fields survive the delete stamp", async () => {
    // Rows written before slackMeta nesting carry the Slack envelope flat in
    // messages.metadata. The stamp bases on the mapped envelope, so thread
    // and display identity remain readable beside deletedAt instead of
    // being shadowed by a minimal synthesis.
    const seeded = seedSlackMessage({
      externalChatId: "C0123CHANNEL",
      originalTs: "3333.3333",
      content: "Flat legacy text",
      withSlackMeta: false,
    });
    const db = getDb();
    db.update(messages)
      .set({
        metadata: JSON.stringify({
          source: "slack",
          channelId: seeded.externalChatId,
          channelTs: seeded.originalTs,
          threadTs: "3000.0001",
          eventKind: "message",
          displayName: "Flat User",
        }),
      })
      .where(eq(messages.id, seeded.messageId))
      .run();

    const req = buildSlackDeleteRequest({
      externalChatId: seeded.externalChatId,
      deletedTs: seeded.originalTs,
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.deleted).toBe(true);

    const row = db
      .select()
      .from(messages)
      .where(eq(messages.id, seeded.messageId))
      .get();
    const neutral = readProviderMetadata(row!.metadata);
    expect(neutral).not.toBeNull();
    expect(neutral!.deletedAt).toBeDefined();
    expect(neutral!.threadId).toBe("3000.0001");
    expect(neutral!.displayName).toBe("Flat User");
  });

  test("a row with malformed metadata still records its delete", async () => {
    const seeded = seedSlackMessage({
      externalChatId: "C0123CHANNEL",
      originalTs: "4444.4444",
      content: "Row with broken envelope",
      withSlackMeta: false,
    });
    const db = getDb();
    db.update(messages)
      .set({ metadata: "{not json" })
      .where(eq(messages.id, seeded.messageId))
      .run();

    const req = buildSlackDeleteRequest({
      externalChatId: seeded.externalChatId,
      deletedTs: seeded.originalTs,
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(true);

    const row = db
      .select()
      .from(messages)
      .where(eq(messages.id, seeded.messageId))
      .get();
    const neutral = readProviderMetadata(row!.metadata);
    expect(neutral).not.toBeNull();
    expect(neutral!.deletedAt).toBeDefined();
  });

  test("delete missing sourceMetadata.messageId is a no-op", async () => {
    const seeded = seedSlackMessage({
      externalChatId: "C0123CHANNEL",
      originalTs: "3333.3333",
      content: "Untouched",
      withSlackMeta: true,
    });

    const req = new Request("http://localhost:8080/channels/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Origin": TEST_BEARER_TOKEN,
      },
      body: JSON.stringify({
        sourceChannel: "slack",
        interface: "slack",
        conversationExternalId: seeded.externalChatId,
        externalMessageId: "evt-del-no-source",
        content: "",
        callbackData: "message_deleted",
        actorExternalId: SLACK_DELETE_ACTOR_ID,
        // sourceMetadata intentionally omitted
      }),
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(false);

    const db = getDb();
    const row = db
      .select()
      .from(messages)
      .where(eq(messages.id, seeded.messageId))
      .get();
    const parsed = JSON.parse(row!.metadata!) as Record<string, unknown>;
    const slackMeta = readSlackMetadata(parsed.slackMeta as string);
    expect(slackMeta!.deletedAt).toBeUndefined();
  });

  test("delete that races ahead of linkMessage is retried until the link lands", async () => {
    // Simulates the race: a delete webhook arrives after `recordInbound`
    // has inserted the original event row but before the agent-loop path
    // has called `linkMessage` to bind it to a stored message. Without
    // the retry loop the delete would silently no-op and the deletion
    // signal would be lost.
    const db = getDb();
    const externalChatId = "C0123CHANNEL";
    const originalTs = "5555.5555";
    const inbound = recordInbound("slack", externalChatId, originalTs, {
      sourceMessageId: originalTs,
    });

    const messageId = `msg-${originalTs}`;
    const slackMeta = writeSlackMetadata({
      source: "slack",
      channelId: externalChatId,
      channelTs: originalTs,
      eventKind: "message",
      displayName: "Test User",
    });
    db.insert(messages)
      .values({
        id: messageId,
        conversationId: inbound.conversationId,
        role: "user",
        content: "Original text",
        createdAt: Date.now(),
        metadata: JSON.stringify({
          userMessageChannel: "slack",
          userMessageInterface: "slack",
          slackMeta,
        }),
      })
      .run();

    // Shorten retries to a handful of small backoffs so the test is fast
    // while still exercising the loop.
    _setDeleteLookupConfigForTests(5, 50);

    // Link the message after a short delay — this lands during one of the
    // retry backoffs. Intentionally not awaited.
    const LINK_DELAY_MS = 120;
    setTimeout(() => {
      linkMessage(inbound.eventId, messageId);
    }, LINK_DELAY_MS);

    const req = buildSlackDeleteRequest({
      externalChatId,
      deletedTs: originalTs,
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(resp.status).toBe(200);
    expect(json.accepted).toBe(true);
    expect(json.deleted).toBe(true);
    expect(json.messageId).toBe(messageId);

    const row = db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .get();
    const parsed = JSON.parse(row!.metadata!) as Record<string, unknown>;
    const parsedSlackMeta = readSlackMetadata(parsed.slackMeta as string);
    expect(parsedSlackMeta!.deletedAt).toBeDefined();
  });

  test("delete from non-member actor is rejected by ACL and does not apply", async () => {
    // Use a channel where NO active member is seeded so the actor cannot
    // resolve via the channel's externalChatId either. Verifies that ACL
    // enforcement rejects delete events from non-members before the delete
    // handler processes them — the delete must not apply and no row should
    // be mutated when the actor is not an active member of the target
    // channel. Also clear the C0123CHANNEL seed for the alt channel below
    // since beforeEach wires the seed on C0123CHANNEL only.
    const altChannel = "C0_NON_MEMBER_CHAN";
    const seeded = seedSlackMessage({
      externalChatId: altChannel,
      originalTs: "7777.7777",
      content: "Original audited text",
      withSlackMeta: true,
    });

    const req = buildSlackDeleteRequest({
      externalChatId: seeded.externalChatId,
      deletedTs: seeded.originalTs,
      actorExternalId: "U_NON_MEMBER",
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    // ACL denies the inbound — the response must not carry `deleted: true`.
    expect(json.deleted).not.toBe(true);

    // The original row remains unmodified — content untouched and no
    // deletedAt marker stamped on slackMeta.
    const db = getDb();
    const row = db
      .select()
      .from(messages)
      .where(eq(messages.id, seeded.messageId))
      .get();
    expect(row!.content).toBe("Original audited text");
    const parsed = JSON.parse(row!.metadata!) as Record<string, unknown>;
    const slackMeta = readSlackMetadata(parsed.slackMeta as string);
    expect(slackMeta!.deletedAt).toBeUndefined();
  });
});
