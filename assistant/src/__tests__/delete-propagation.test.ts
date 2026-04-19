/**
 * Tests for Slack message_deleted propagation into stored messages.
 *
 * The gateway forwards delete events with `callbackData = "message_deleted"`
 * and `sourceMetadata.messageId` set to the deleted message's ts. The daemon
 * marks the corresponding stored row's `slackMeta.deletedAt` while leaving
 * the `content` column untouched (audit retention; the renderer elides based
 * on the deletedAt marker).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

import { eq } from "drizzle-orm";

import { getDb, initializeDb } from "../memory/db.js";
import { linkMessage, recordInbound } from "../memory/delivery-crud.js";
import { messages } from "../memory/schema.js";
import {
  readSlackMetadata,
  writeSlackMetadata,
} from "../messaging/providers/slack/message-metadata.js";
import { handleChannelInbound } from "../runtime/routes/channel-routes.js";

initializeDb();

const TEST_BEARER_TOKEN = "test-token";

function resetState(): void {
  const db = getDb();
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM conversation_keys");
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
      actorExternalId: "slack-system",
      sourceMetadata: {
        // The original (deleted) message's ts — the lookup key.
        messageId: opts.deletedTs,
      },
    }),
  });
}

describe("Slack delete propagation", () => {
  beforeEach(() => {
    resetState();
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

  test("delete for row without slackMeta is a no-op (legacy row)", async () => {
    const seeded = seedSlackMessage({
      externalChatId: "C0123CHANNEL",
      originalTs: "2222.2222",
      content: "Legacy pre-upgrade text",
      withSlackMeta: false,
    });

    const req = buildSlackDeleteRequest({
      externalChatId: seeded.externalChatId,
      deletedTs: seeded.originalTs,
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

    expect(row!.content).toBe("Legacy pre-upgrade text");
    const parsed = JSON.parse(row!.metadata!) as Record<string, unknown>;
    expect(parsed.slackMeta).toBeUndefined();
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
        actorExternalId: "slack-system",
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
});
