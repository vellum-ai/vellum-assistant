import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb, initializeDb } from "../memory/db.js";
import * as deliveryCrud from "../memory/delivery-crud.js";
import { channelInboundEvents, messages } from "../memory/schema.js";
import { sweepFailedEvents } from "../runtime/channel-retry-sweep.js";

initializeDb();

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

      await sweepFailedEvents(
        async (conversationId, _content, _attachmentIds, options) => {
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
        },
      );

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

  test("marks legacy payloads with only actorRole (no trustClass) as failed", async () => {
    const actorRoles: Array<
      "guardian" | "non-guardian" | "unverified_channel"
    > = ["guardian", "non-guardian", "unverified_channel"];

    for (const actorRole of actorRoles) {
      resetTables();
      const eventId = seedFailedEventWithActorRoleOnly(actorRole);
      let processMessageCalled = false;

      await sweepFailedEvents(
        async (conversationId, _content, _attachmentIds, _options) => {
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
        },
      );

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

    await sweepFailedEvents(
      async (conversationId, _content, _attachmentIds, _options) => {
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
      },
    );

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

    await sweepFailedEvents(
      async (conversationId, _content, _attachmentIds, options) => {
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
      },
    );

    // When trustCtx is absent, the sweep synthesizes an explicit 'unknown'
    // trust context to prevent downstream defaults from granting guardian trust.
    expect(capturedOptions?.trustContext?.trustClass).toBe("unknown");
    expect(capturedOptions?.trustContext?.sourceChannel).toBe("telegram");
    expect(capturedOptions?.isInteractive).toBe(false);
  });
});
