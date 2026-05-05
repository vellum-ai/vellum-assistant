import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import type { DiskPressureStatus } from "../daemon/disk-pressure-guard.js";

const deliverChannelReplyMock = mock(
  async (_callbackUrl: string, _payload: Record<string, unknown>) => {},
);

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: deliverChannelReplyMock,
}));

const lockedDiskPressureStatus: DiskPressureStatus = {
  enabled: true,
  state: "critical",
  locked: true,
  acknowledged: true,
  overrideActive: false,
  effectivelyLocked: true,
  lockId: "disk-pressure-test",
  usagePercent: 98,
  thresholdPercent: 95,
  path: "/workspace",
  lastCheckedAt: "2026-05-05T00:00:00.000Z",
  blockedCapabilities: ["agent-turns", "background-work", "remote-ingress"],
  error: null,
};
const disabledDiskPressureStatus: DiskPressureStatus = {
  enabled: false,
  state: "disabled",
  locked: false,
  acknowledged: false,
  overrideActive: false,
  effectivelyLocked: false,
  lockId: null,
  usagePercent: null,
  thresholdPercent: 95,
  path: null,
  lastCheckedAt: null,
  blockedCapabilities: [],
  error: null,
};
let diskPressureStatus = lockedDiskPressureStatus;

mock.module("../daemon/disk-pressure-guard.js", () => ({
  getDiskPressureStatus: () => diskPressureStatus,
}));

import { upsertContact } from "../contacts/contact-store.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import * as deliveryCrud from "../memory/delivery-crud.js";
import {
  canonicalGuardianRequests,
  channelInboundEvents,
  messages,
} from "../memory/schema.js";
import { sweepFailedEvents } from "../runtime/channel-retry-sweep.js";
import {
  handleChannelInbound,
  setAdapterProcessMessage,
} from "./helpers/channel-test-adapter.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM channel_guardian_approval_requests");
  db.run("DELETE FROM canonical_guardian_requests");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
}

function seedTrustedContact(policy: "allow" | "escalate" = "allow"): void {
  upsertContact({
    displayName: "Example User",
    channels: [
      {
        type: "telegram",
        address: "telegram-user-1",
        externalUserId: "telegram-user-1",
        status: "active",
        policy,
      },
    ],
  });
}

function makeInboundRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/channels/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Origin": "test-token",
    },
    body: JSON.stringify({
      sourceChannel: "telegram",
      interface: "telegram",
      conversationExternalId: "chat-123",
      externalMessageId: `msg-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      content: "hello",
      actorExternalId: "telegram-user-1",
      replyCallbackUrl: "https://gateway.test/deliver/telegram",
      ...overrides,
    }),
  });
}

describe("channel inbound disk pressure gate", () => {
  beforeEach(() => {
    resetTables();
    seedTrustedContact();
    setAdapterProcessMessage(undefined);
    deliverChannelReplyMock.mockClear();
    diskPressureStatus = lockedDiskPressureStatus;
  });

  afterAll(() => {
    diskPressureStatus = disabledDiskPressureStatus;
  });

  test("blocks trusted-contact ingress before payload persistence or processing", async () => {
    const processMessage = mock(async () => {
      throw new Error("processMessage should not run");
    });
    setAdapterProcessMessage(processMessage);

    const res = await handleChannelInbound(makeInboundRequest());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      accepted: true,
      duplicate: false,
      diskPressure: "blocked",
      reason: "trusted-contact",
    });
    expect(processMessage).not.toHaveBeenCalled();
    expect(deliverChannelReplyMock).toHaveBeenCalledWith(
      "https://gateway.test/deliver/telegram",
      expect.objectContaining({
        chatId: "chat-123",
        text: expect.stringContaining("trusted contacts are paused"),
      }),
    );

    const db = getDb();
    const event = db.select().from(channelInboundEvents).get();
    expect(event?.processingStatus).toBe("processed");
    expect(event?.messageId).toBeNull();
    expect(event?.rawPayload).toBeNull();
    expect(db.select().from(messages).all()).toHaveLength(0);
  });

  test("blocks escalation-policy trusted-contact ingress before escalation state", async () => {
    resetTables();
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-1",
      guardianDeliveryChatId: "guardian-chat-1",
      guardianPrincipalId: "guardian-user-1",
    });
    seedTrustedContact("escalate");
    const processMessage = mock(async () => {
      throw new Error("processMessage should not run");
    });
    setAdapterProcessMessage(processMessage);

    const res = await handleChannelInbound(
      makeInboundRequest({ externalMessageId: "msg-escalate-blocked" }),
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      accepted: true,
      duplicate: false,
      diskPressure: "blocked",
      reason: "trusted-contact",
    });
    expect(processMessage).not.toHaveBeenCalled();

    const db = getDb();
    const event = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.externalMessageId, "msg-escalate-blocked"))
      .get();
    expect(event?.processingStatus).toBe("processed");
    expect(event?.messageId).toBeNull();
    expect(event?.rawPayload).toBeNull();

    expect(db.select().from(canonicalGuardianRequests).all()).toHaveLength(0);
    expect(db.select().from(messages).all()).toHaveLength(0);
  });

  test("marks trusted-contact retry-sweep events processed without replaying", async () => {
    const inbound = deliveryCrud.recordInbound(
      "telegram",
      "chat-retry",
      "msg-retry",
    );
    deliveryCrud.storePayload(inbound.eventId, {
      content: "retry me",
      sourceChannel: "telegram",
      interface: "telegram",
      externalChatId: "chat-retry",
      trustCtx: {
        trustClass: "trusted_contact",
        sourceChannel: "telegram",
        requesterExternalUserId: "telegram-user-1",
        requesterChatId: "chat-retry",
      },
      replyCallbackUrl: "https://gateway.test/deliver/telegram",
    });

    const db = getDb();
    db.update(channelInboundEvents)
      .set({
        processingStatus: "failed",
        processingAttempts: 1,
        retryAfter: Date.now() - 1,
      })
      .where(eq(channelInboundEvents.id, inbound.eventId))
      .run();

    const processMessage = mock(async () => ({ messageId: "msg-should-not" }));
    await sweepFailedEvents(processMessage);

    expect(processMessage).not.toHaveBeenCalled();
    expect(deliverChannelReplyMock).toHaveBeenCalledWith(
      "https://gateway.test/deliver/telegram",
      expect.objectContaining({
        chatId: "chat-retry",
        text: expect.stringContaining("trusted contacts are paused"),
      }),
    );

    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, inbound.eventId))
      .get();
    expect(row?.processingStatus).toBe("processed");
    expect(row?.messageId).toBeNull();
    expect(row?.rawPayload).toBeNull();
  });

  test("uses ephemeral Slack retry block replies targeted to the requester", async () => {
    const inbound = deliveryCrud.recordInbound(
      "slack",
      "slack-channel-1",
      "slack-msg-retry",
    );
    deliveryCrud.storePayload(inbound.eventId, {
      content: "retry me",
      sourceChannel: "slack",
      interface: "slack",
      externalChatId: "slack-channel-1",
      trustCtx: {
        trustClass: "trusted_contact",
        sourceChannel: "slack",
        requesterExternalUserId: "slack-user-1",
        requesterChatId: "slack-channel-1",
      },
      replyCallbackUrl: "https://gateway.test/deliver/slack",
    });

    const db = getDb();
    db.update(channelInboundEvents)
      .set({
        processingStatus: "failed",
        processingAttempts: 1,
        retryAfter: Date.now() - 1,
      })
      .where(eq(channelInboundEvents.id, inbound.eventId))
      .run();

    const processMessage = mock(async () => ({ messageId: "msg-should-not" }));
    await sweepFailedEvents(processMessage);

    expect(processMessage).not.toHaveBeenCalled();
    expect(deliverChannelReplyMock).toHaveBeenCalledWith(
      "https://gateway.test/deliver/slack",
      expect.objectContaining({
        chatId: "slack-channel-1",
        ephemeral: true,
        user: "slack-user-1",
        text: expect.stringContaining("trusted contacts are paused"),
      }),
    );

    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, inbound.eventId))
      .get();
    expect(row?.processingStatus).toBe("processed");
    expect(row?.messageId).toBeNull();
    expect(row?.rawPayload).toBeNull();
  });
});
