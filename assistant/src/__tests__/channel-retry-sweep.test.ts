import { beforeEach, describe, expect, mock, test } from "bun:test";

import { asc, eq } from "drizzle-orm";

const deliveryCalls: Array<{
  conversationId: string;
  externalChatId: string;
  callbackUrl: string;
  assistantId?: string;
  messageId?: string;
  startFromSegment?: number;
  messageTs?: string;
}> = [];
const liveDeliveryCalls: Array<{
  callbackUrl: string;
  payload: Record<string, unknown>;
}> = [];
let deliverReplyViaCallbackImpl: (
  ...args: unknown[]
) => Promise<void> = async () => {};
let deliverChannelReplyImpl: (
  callbackUrl: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>> = async () => ({ ok: true });

mock.module("../runtime/channel-reply-delivery.js", () => ({
  deliverReplyViaCallback: async (
    conversationId: string,
    externalChatId: string,
    callbackUrl: string,
    assistantId?: string,
    options?: {
      messageId?: string;
      startFromSegment?: number;
      messageTs?: string;
    },
  ) => {
    const call: (typeof deliveryCalls)[number] = {
      conversationId,
      externalChatId,
      callbackUrl,
      assistantId,
      messageId: options?.messageId,
      startFromSegment: options?.startFromSegment,
    };
    if (options?.messageTs !== undefined) {
      call.messageTs = options.messageTs;
    }
    deliveryCalls.push(call);
    return deliverReplyViaCallbackImpl(
      conversationId,
      externalChatId,
      callbackUrl,
      assistantId,
      options,
    );
  },
  findAssistantReplyMessageIdForTurn: (
    conversationId: string,
    userMessageId: string,
  ): string | undefined => {
    const rows = getDb()
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt))
      .all();
    const userIndex = rows.findIndex((row) => row.id === userMessageId);
    if (userIndex === -1) return undefined;
    let candidate: string | undefined;
    for (let i = userIndex + 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.role === "user") break;
      if (row.role === "assistant") {
        candidate = row.id;
      }
    }
    return candidate;
  },
}));

mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (
    callbackUrl: string,
    payload: Record<string, unknown>,
  ) => {
    liveDeliveryCalls.push({ callbackUrl, payload });
    return deliverChannelReplyImpl(callbackUrl, payload);
  },
}));

import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import * as deliveryCrud from "../persistence/delivery-crud.js";
import { channelInboundEvents, messages } from "../persistence/schema/index.js";
import { sweepFailedEvents } from "../runtime/channel-retry-sweep.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function seedFailedEventWithTrustClass(
  trustClass: string,
  extra?: Record<string, unknown>,
): string {
  const inbound = deliveryCrud.recordInbound(
    "telegram",
    `chat-${trustClass}`,
    `msg-${trustClass}`,
  );
  deliveryCrud.storePayload(inbound.eventId, {
    content: "retry me",
    sourceChannel: "telegram",
    interface: "telegram",
    trustCtx: {
      trustClass,
      sourceChannel: "telegram",
      guardianPrincipalId: "principal-1",
      requesterExternalUserId: "user-1",
      requesterChatId: `chat-${trustClass}`,
      ...extra,
    },
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

  return inbound.eventId;
}

function seedFailedEventWithActorRoleOnly(
  actorRole: "guardian" | "non-guardian" | "unverified_channel",
): string {
  const inbound = deliveryCrud.recordInbound(
    "telegram",
    `chat-legacy-${actorRole}`,
    `msg-legacy-${actorRole}`,
  );
  deliveryCrud.storePayload(inbound.eventId, {
    content: "retry me",
    sourceChannel: "telegram",
    interface: "telegram",
    trustCtx: {
      actorRole,
      sourceChannel: "telegram",
      requesterExternalUserId: "legacy-user",
      requesterChatId: `chat-legacy-${actorRole}`,
    },
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

  return inbound.eventId;
}

describe("channel-retry-sweep", () => {
  beforeEach(() => {
    resetTables();
    deliveryCalls.length = 0;
    liveDeliveryCalls.length = 0;
    deliverReplyViaCallbackImpl = async () => {};
    deliverChannelReplyImpl = async () => ({ ok: true });
  });

  test("replays canonical payloads with trustClass correctly", async () => {
    const cases: Array<{
      trustClass: "guardian" | "trusted_contact" | "unknown";
      expectedInteractive: boolean;
    }> = [
      { trustClass: "guardian", expectedInteractive: true },
      { trustClass: "trusted_contact", expectedInteractive: false },
      { trustClass: "unknown", expectedInteractive: false },
    ];

    for (const c of cases) {
      resetTables();
      const eventId = seedFailedEventWithTrustClass(c.trustClass);
      let capturedOptions:
        | {
            trustContext?: {
              trustClass?: string;
              guardianPrincipalId?: string;
            };
            isInteractive?: boolean;
          }
        | undefined;

      await sweepFailedEvents(async (conversationId, _content, options) => {
        capturedOptions = options as {
          trustContext?: {
            trustClass?: string;
            guardianPrincipalId?: string;
          };
          isInteractive?: boolean;
        };
        const messageId = `message-${c.trustClass}`;
        const db = getDb();
        db.insert(messages)
          .values({
            id: messageId,
            conversationId,
            role: "user",
            content: JSON.stringify([{ type: "text", text: "retry me" }]),
            createdAt: Date.now(),
          })
          .run();
        return { messageId };
      });

      expect(capturedOptions?.trustContext?.trustClass).toBe(c.trustClass);
      expect(capturedOptions?.trustContext?.guardianPrincipalId).toBe(
        "principal-1",
      );
      expect(capturedOptions?.isInteractive).toBe(c.expectedInteractive);

      const db = getDb();
      const row = db
        .select()
        .from(channelInboundEvents)
        .where(eq(channelInboundEvents.id, eventId))
        .get();
      expect(row?.processingStatus).toBe("processed");
    }
  });

  test("restores member-grounding + timezone trust fields on replay", async () => {
    const eventId = seedFailedEventWithTrustClass("trusted_contact", {
      requesterContactId: "contact-77",
      memberStatus: "active",
      memberPolicy: "allow",
      requesterTimezone: "America/New_York",
      requesterTimezoneLabel: "EST",
      requesterTimezoneOffsetSeconds: -18000,
    });

    let capturedTrust: Record<string, unknown> | undefined;
    await sweepFailedEvents(async (conversationId, _content, options) => {
      capturedTrust = (options as { trustContext?: Record<string, unknown> })
        .trustContext;
      const messageId = "message-grounding";
      getDb()
        .insert(messages)
        .values({
          id: messageId,
          conversationId,
          role: "user",
          content: JSON.stringify([{ type: "text", text: "retry me" }]),
          createdAt: Date.now(),
        })
        .run();
      return { messageId };
    });

    // Member-grounding + timezone fields survive the store→replay round-trip,
    // so the replayed turn keeps its member grounding.
    expect(capturedTrust?.requesterContactId).toBe("contact-77");
    expect(capturedTrust?.memberStatus).toBe("active");
    expect(capturedTrust?.memberPolicy).toBe("allow");
    expect(capturedTrust?.requesterTimezone).toBe("America/New_York");
    expect(capturedTrust?.requesterTimezoneLabel).toBe("EST");
    expect(capturedTrust?.requesterTimezoneOffsetSeconds).toBe(-18000);

    const eventRow = getDb()
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, eventId))
      .get();
    expect(eventRow?.processingStatus).toBe("processed");
  });

  test("marks legacy payloads with only actorRole (no trustClass) as failed", async () => {
    const actorRoles: Array<
      "guardian" | "non-guardian" | "unverified_channel"
    > = ["guardian", "non-guardian", "unverified_channel"];

    for (const actorRole of actorRoles) {
      resetTables();
      const eventId = seedFailedEventWithActorRoleOnly(actorRole);
      let processMessageCalled = false;

      await sweepFailedEvents(async (conversationId, _content, _options) => {
        processMessageCalled = true;
        const messageId = `message-legacy-${actorRole}`;
        const db = getDb();
        db.insert(messages)
          .values({
            id: messageId,
            conversationId,
            role: "user",
            content: JSON.stringify([{ type: "text", text: "retry me" }]),
            createdAt: Date.now(),
          })
          .run();
        return { messageId };
      });

      // Legacy payloads with trustCtx that can't be parsed into canonical form
      // must be marked as failed to prevent privilege escalation — processMessage
      // should never be called.
      expect(processMessageCalled).toBe(false);

      const db = getDb();
      const row = db
        .select()
        .from(channelInboundEvents)
        .where(eq(channelInboundEvents.id, eventId))
        .get();
      expect(row?.processingStatus).toBe("failed");
    }
  });

  test("marks payloads with invalid trustClass values as failed", async () => {
    resetTables();
    const eventId = seedFailedEventWithTrustClass("invalid_value");
    let processMessageCalled = false;

    await sweepFailedEvents(async (conversationId, _content, _options) => {
      processMessageCalled = true;
      const messageId = "message-invalid";
      const db = getDb();
      db.insert(messages)
        .values({
          id: messageId,
          conversationId,
          role: "user",
          content: JSON.stringify([{ type: "text", text: "retry me" }]),
          createdAt: Date.now(),
        })
        .run();
      return { messageId };
    });

    // trustCtx was present but couldn't be parsed (invalid trustClass),
    // so the event must be failed rather than processed without trust context.
    expect(processMessageCalled).toBe(false);

    const db = getDb();
    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, eventId))
      .get();
    expect(row?.processingStatus).toBe("failed");
  });

  test("synthesizes unknown trust context when trustCtx is missing", async () => {
    const inbound = deliveryCrud.recordInbound(
      "telegram",
      "chat-no-ctx",
      "msg-no-ctx",
    );
    deliveryCrud.storePayload(inbound.eventId, {
      content: "retry me",
      sourceChannel: "telegram",
      interface: "telegram",
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

    let capturedOptions:
      | {
          trustContext?: { trustClass?: string; sourceChannel?: string };
          isInteractive?: boolean;
        }
      | undefined;

    await sweepFailedEvents(async (conversationId, _content, options) => {
      capturedOptions = options as {
        trustContext?: { trustClass?: string; sourceChannel?: string };
        isInteractive?: boolean;
      };
      const messageId = "message-no-ctx";
      db.insert(messages)
        .values({
          id: messageId,
          conversationId,
          role: "user",
          content: JSON.stringify([{ type: "text", text: "retry me" }]),
          createdAt: Date.now(),
        })
        .run();
      return { messageId };
    });

    // When trustCtx is absent, the sweep synthesizes an explicit 'unknown'
    // trust context to prevent downstream defaults from granting guardian trust.
    expect(capturedOptions?.trustContext?.trustClass).toBe("unknown");
    expect(capturedOptions?.trustContext?.sourceChannel).toBe("telegram");
    expect(capturedOptions?.isInteractive).toBe(false);
  });

  test("delivery failure after successful replay does not requeue processing", async () => {
    const inbound = deliveryCrud.recordInbound(
      "telegram",
      "chat-delivery-fails",
      "msg-delivery-fails",
    );
    deliveryCrud.storePayload(inbound.eventId, {
      content: "retry me",
      sourceChannel: "telegram",
      interface: "telegram",
      externalChatId: "chat-delivery-fails",
      replyCallbackUrl: "https://example.test/deliver/telegram",
      trustCtx: {
        trustClass: "unknown",
        sourceChannel: "telegram",
        requesterChatId: "chat-delivery-fails",
      },
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
    deliverReplyViaCallbackImpl = async () => {
      throw new Error("fetch failed");
    };

    let processMessageCalls = 0;
    await sweepFailedEvents(async (conversationId, _content, options) => {
      processMessageCalls++;
      options?.onEvent?.({
        type: "message_complete",
        conversationId,
        messageId: "assistant-delivery-fails",
      });
      const messageId = "message-delivery-fails";
      db.insert(messages)
        .values({
          id: messageId,
          conversationId,
          role: "user",
          content: JSON.stringify([{ type: "text", text: "retry me" }]),
          createdAt: Date.now(),
        })
        .run();
      return { messageId };
    });

    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, inbound.eventId))
      .get();
    expect(processMessageCalls).toBe(1);
    expect(deliveryCalls).toHaveLength(1);
    expect(row?.processingStatus).toBe("processed");
    expect(row?.deliveryStatus).toBe("failed");
    expect(row?.messageId).toBe("message-delivery-fails");
    expect(
      row?.rawPayload ? JSON.parse(row.rawPayload).replyMessageId : undefined,
    ).toBe("assistant-delivery-fails");
  });

  test("Slack DM processing retry reconciles into the streamed message without opening a second stream", async () => {
    const inbound = deliveryCrud.recordInbound(
      "slack",
      "D-LIVE-RETRY",
      "slack-msg-live-retry",
    );
    deliveryCrud.storePayload(inbound.eventId, {
      content: "retry me",
      sourceChannel: "slack",
      interface: "slack",
      externalChatId: "D-LIVE-RETRY",
      replyCallbackUrl: "https://example.test/deliver/slack",
      sourceMetadata: { chatType: "im" },
      trustCtx: {
        trustClass: "unknown",
        sourceChannel: "slack",
        requesterChatId: "D-LIVE-RETRY",
      },
      // A prior attempt streamed a message before failing.
      slackStreamMessageTs: "1700000000.000044",
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

    await sweepFailedEvents(async (conversationId, _content, options) => {
      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "Reprocessed response.",
        conversationId,
      });
      options?.onEvent?.({
        type: "message_complete",
        conversationId,
        messageId: "assistant-live-retry-final",
      });
      db.insert(messages)
        .values({
          id: "user-live-retry",
          conversationId,
          role: "user",
          content: JSON.stringify([{ type: "text", text: "retry me" }]),
          createdAt: Date.now(),
        })
        .run();
      return { messageId: "user-live-retry" };
    });

    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, inbound.eventId))
      .get();
    const rawPayload = row?.rawPayload
      ? (JSON.parse(row.rawPayload) as Record<string, unknown>)
      : {};

    // A retry never streams; durable delivery edits the prior streamed message
    // in place from the first segment, so the reply is not duplicated.
    expect(liveDeliveryCalls).toEqual([]);
    expect(deliveryCalls).toEqual([
      {
        conversationId: inbound.conversationId,
        externalChatId: "D-LIVE-RETRY",
        callbackUrl: "https://example.test/deliver/slack",
        assistantId: undefined,
        messageId: "assistant-live-retry-final",
        startFromSegment: 0,
        messageTs: "1700000000.000044",
      },
    ]);
    expect(rawPayload.replyMessageId).toBe("assistant-live-retry-final");
    expect(rawPayload.slackStreamMessageTs).toBe("1700000000.000044");
    expect(row?.processingStatus).toBe("processed");
    expect(row?.deliveryStatus).toBe("delivered");
  });

  test("Slack DM processing retry with no prior stream delivers the full reply normally", async () => {
    const inbound = deliveryCrud.recordInbound(
      "slack",
      "D-LIVE-RETRY-SAME-REPLY",
      "slack-msg-live-retry-same-reply",
    );
    deliveryCrud.storePayload(inbound.eventId, {
      content: "retry me",
      sourceChannel: "slack",
      interface: "slack",
      externalChatId: "D-LIVE-RETRY-SAME-REPLY",
      replyCallbackUrl: "https://example.test/deliver/slack",
      sourceMetadata: { chatType: "im" },
      trustCtx: {
        trustClass: "unknown",
        sourceChannel: "slack",
        requesterChatId: "D-LIVE-RETRY-SAME-REPLY",
      },
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

    await sweepFailedEvents(async (conversationId, _content, options) => {
      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "Live retry response.",
        conversationId,
      });
      options?.onEvent?.({
        type: "message_complete",
        conversationId,
        messageId: "assistant-live-retry-same-reply",
      });
      db.insert(messages)
        .values({
          id: "user-live-retry-same-reply",
          conversationId,
          role: "user",
          content: JSON.stringify([{ type: "text", text: "retry me" }]),
          createdAt: Date.now(),
        })
        .run();
      return { messageId: "user-live-retry-same-reply" };
    });

    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, inbound.eventId))
      .get();
    const rawPayload = row?.rawPayload
      ? (JSON.parse(row.rawPayload) as Record<string, unknown>)
      : {};

    expect(liveDeliveryCalls).toEqual([]);
    expect(deliveryCalls).toEqual([
      {
        conversationId: inbound.conversationId,
        externalChatId: "D-LIVE-RETRY-SAME-REPLY",
        callbackUrl: "https://example.test/deliver/slack",
        assistantId: undefined,
        messageId: "assistant-live-retry-same-reply",
        startFromSegment: 0,
      },
    ]);
    expect(rawPayload.slackStreamMessageTs).toBeUndefined();
    expect(rawPayload.replyMessageId).toBe("assistant-live-retry-same-reply");
    expect(row?.processingStatus).toBe("processed");
    expect(row?.deliveryStatus).toBe("delivered");
  });

  test("Slack DM processing retry preserves the streamed message ts when delivery fails again", async () => {
    const inbound = deliveryCrud.recordInbound(
      "slack",
      "D-LIVE-RETRY-FINAL-FAILS",
      "slack-msg-live-retry-final-fails",
    );
    deliveryCrud.storePayload(inbound.eventId, {
      content: "retry me",
      sourceChannel: "slack",
      interface: "slack",
      externalChatId: "D-LIVE-RETRY-FINAL-FAILS",
      replyCallbackUrl: "https://example.test/deliver/slack",
      sourceMetadata: { chatType: "im" },
      trustCtx: {
        trustClass: "unknown",
        sourceChannel: "slack",
        requesterChatId: "D-LIVE-RETRY-FINAL-FAILS",
      },
      slackStreamMessageTs: "1700000000.000055",
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
    deliverReplyViaCallbackImpl = async () => {
      throw new Error("fetch failed before progress callback");
    };

    await sweepFailedEvents(async (conversationId, _content, options) => {
      options?.onEvent?.({
        type: "assistant_text_delta",
        text: "Live retry response.",
        conversationId,
      });
      options?.onEvent?.({
        type: "message_complete",
        conversationId,
        messageId: "assistant-live-retry-final-fails",
      });
      db.insert(messages)
        .values({
          id: "user-live-retry-final-fails",
          conversationId,
          role: "user",
          content: JSON.stringify([{ type: "text", text: "retry me" }]),
          createdAt: Date.now(),
        })
        .run();
      return { messageId: "user-live-retry-final-fails" };
    });

    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, inbound.eventId))
      .get();
    const rawPayload = row?.rawPayload
      ? (JSON.parse(row.rawPayload) as Record<string, unknown>)
      : {};

    expect(liveDeliveryCalls).toEqual([]);
    expect(deliveryCalls).toEqual([
      {
        conversationId: inbound.conversationId,
        externalChatId: "D-LIVE-RETRY-FINAL-FAILS",
        callbackUrl: "https://example.test/deliver/slack",
        assistantId: undefined,
        messageId: "assistant-live-retry-final-fails",
        startFromSegment: 0,
        messageTs: "1700000000.000055",
      },
    ]);
    // The streamed ts survives so a later retry still reconciles in place.
    expect(rawPayload.slackStreamMessageTs).toBe("1700000000.000055");
    expect(row?.deliveryStatus).toBe("failed");
  });

  test("delivery retry for processed events resumes delivery without processing", async () => {
    const inbound = deliveryCrud.recordInbound(
      "telegram",
      "chat-delivery-only",
      "msg-delivery-only",
    );
    deliveryCrud.storePayload(inbound.eventId, {
      content: "already processed",
      sourceChannel: "telegram",
      interface: "telegram",
      externalChatId: "chat-delivery-only",
      replyCallbackUrl: "https://example.test/deliver/telegram",
      assistantId: "assistant-1",
      replyMessageId: "assistant-delivery-only",
    });

    const db = getDb();
    db.update(channelInboundEvents)
      .set({
        processingStatus: "processed",
        deliveryStatus: "failed",
        processingAttempts: 1,
        retryAfter: Date.now() - 1,
        deliveredSegmentCount: 2,
      })
      .where(eq(channelInboundEvents.id, inbound.eventId))
      .run();

    let processMessageCalls = 0;
    await sweepFailedEvents(async () => {
      processMessageCalls++;
      throw new Error("processMessage should not be called");
    });

    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, inbound.eventId))
      .get();
    expect(processMessageCalls).toBe(0);
    expect(deliveryCalls).toEqual([
      {
        conversationId: inbound.conversationId,
        externalChatId: "chat-delivery-only",
        callbackUrl: "https://example.test/deliver/telegram",
        assistantId: "assistant-1",
        messageId: "assistant-delivery-only",
        startFromSegment: 2,
      },
    ]);
    expect(row?.processingStatus).toBe("processed");
    expect(row?.deliveryStatus).toBe("delivered");
    expect(row?.retryAfter).toBeNull();
  });

  test("delivery retry edits a prior streamed message in place instead of posting a duplicate", async () => {
    const inbound = deliveryCrud.recordInbound(
      "slack",
      "D-DELIVERY-ONLY-STREAM",
      "msg-delivery-only-stream",
    );
    deliveryCrud.storePayload(inbound.eventId, {
      content: "already processed",
      sourceChannel: "slack",
      interface: "slack",
      externalChatId: "D-DELIVERY-ONLY-STREAM",
      replyCallbackUrl: "https://example.test/deliver/slack",
      assistantId: "assistant-1",
      replyMessageId: "assistant-delivery-only-stream",
      // A prior attempt streamed a message, then delivery failed before any
      // durable segment landed.
      slackStreamMessageTs: "1700000000.000077",
    });

    const db = getDb();
    db.update(channelInboundEvents)
      .set({
        processingStatus: "processed",
        deliveryStatus: "failed",
        processingAttempts: 1,
        retryAfter: Date.now() - 1,
        deliveredSegmentCount: 0,
      })
      .where(eq(channelInboundEvents.id, inbound.eventId))
      .run();

    await sweepFailedEvents(async () => {
      throw new Error("processMessage should not be called");
    });

    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, inbound.eventId))
      .get();
    expect(deliveryCalls).toEqual([
      {
        conversationId: inbound.conversationId,
        externalChatId: "D-DELIVERY-ONLY-STREAM",
        callbackUrl: "https://example.test/deliver/slack",
        assistantId: "assistant-1",
        messageId: "assistant-delivery-only-stream",
        startFromSegment: 0,
        messageTs: "1700000000.000077",
      },
    ]);
    expect(row?.deliveryStatus).toBe("delivered");
  });

  test("delivery retry resolves missing reply id from the linked user turn", async () => {
    const inbound = deliveryCrud.recordInbound(
      "telegram",
      "chat-delivery-fallback",
      "msg-delivery-fallback",
    );
    deliveryCrud.storePayload(inbound.eventId, {
      content: "already processed",
      sourceChannel: "telegram",
      interface: "telegram",
      externalChatId: "chat-delivery-fallback",
      replyCallbackUrl: "https://example.test/deliver/telegram",
      assistantId: "assistant-1",
    });

    const db = getDb();
    db.insert(messages)
      .values([
        {
          id: "user-delivery-fallback",
          conversationId: inbound.conversationId,
          role: "user",
          content: JSON.stringify([
            { type: "text", text: "already processed" },
          ]),
          createdAt: 1_000,
        },
        {
          id: "assistant-delivery-fallback",
          conversationId: inbound.conversationId,
          role: "assistant",
          content: JSON.stringify([{ type: "text", text: "reply" }]),
          createdAt: 1_001,
        },
        {
          id: "user-unrelated",
          conversationId: inbound.conversationId,
          role: "user",
          content: JSON.stringify([{ type: "text", text: "newer turn" }]),
          createdAt: 1_002,
        },
        {
          id: "assistant-unrelated",
          conversationId: inbound.conversationId,
          role: "assistant",
          content: JSON.stringify([{ type: "text", text: "newer reply" }]),
          createdAt: 1_003,
        },
      ])
      .run();
    deliveryCrud.linkMessage(inbound.eventId, "user-delivery-fallback");
    db.update(channelInboundEvents)
      .set({
        processingStatus: "processed",
        deliveryStatus: "failed",
        retryAfter: Date.now() - 1,
      })
      .where(eq(channelInboundEvents.id, inbound.eventId))
      .run();

    let processMessageCalls = 0;
    await sweepFailedEvents(async () => {
      processMessageCalls++;
      throw new Error("processMessage should not be called");
    });

    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, inbound.eventId))
      .get();
    expect(processMessageCalls).toBe(0);
    expect(deliveryCalls).toEqual([
      {
        conversationId: inbound.conversationId,
        externalChatId: "chat-delivery-fallback",
        callbackUrl: "https://example.test/deliver/telegram",
        assistantId: "assistant-1",
        messageId: "assistant-delivery-fallback",
        startFromSegment: 0,
      },
    ]);
    expect(
      row?.rawPayload ? JSON.parse(row.rawPayload).replyMessageId : undefined,
    ).toBe("assistant-delivery-fallback");
    expect(row?.deliveryStatus).toBe("delivered");
  });
});
