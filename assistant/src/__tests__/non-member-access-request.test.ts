/**
 * Tests for the non-member access request notification flow.
 *
 * When a non-member messages the assistant on a channel, the system should:
 * 1. Deny the message with the standard rejection reply
 * 2. Notify the guardian (if a guardian binding exists)
 * 3. Create a guardian approval request for the access request
 * 4. Deduplicate: don't create duplicate requests for repeated messages
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "non-member-access-request-test-"));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

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

// Track emitNotificationSignal calls
const emitSignalCalls: Array<Record<string, unknown>> = [];
let mockEmitResult: {
  signalId: string;
  deduplicated: boolean;
  dispatched: boolean;
  reason: string;
  deliveryResults: Array<Record<string, unknown>>;
} = {
  signalId: "mock-signal-id",
  deduplicated: false,
  dispatched: true,
  reason: "mock",
  deliveryResults: [],
};
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emitSignalCalls.push(params);
    return mockEmitResult;
  },
}));

// Track deliverChannelReply calls
const deliverReplyCalls: Array<{
  url: string;
  payload: Record<string, unknown>;
}> = [];
mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async (
    url: string,
    payload: Record<string, unknown>,
  ) => {
    deliverReplyCalls.push({ url, payload });
  },
}));

import { createGuardianBinding } from "../contacts/contacts-write.js";
import {
  listCanonicalGuardianDeliveries,
  listCanonicalGuardianRequests,
} from "../memory/canonical-guardian-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { notifyGuardianOfAccessRequest } from "../runtime/access-request-helper.js";
import { ensureVellumGuardianBinding } from "../runtime/guardian-vellum-migration.js";
import { handleChannelInbound } from "../runtime/routes/channel-routes.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_BEARER_TOKEN = "test-token";

/**
 * Reset test state and return the vellum anchor principal ID.
 * Guardian bindings created in tests must use this principal so the
 * assistant-anchored resolution check in access-request-helper passes.
 */
function resetState(): string {
  const db = getDb();
  db.run("DELETE FROM channel_guardian_approval_requests");
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM notification_events");
  db.run("DELETE FROM canonical_guardian_requests");
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  emitSignalCalls.length = 0;
  deliverReplyCalls.length = 0;
  mockEmitResult = {
    signalId: "mock-signal-id",
    deduplicated: false,
    dispatched: true,
    reason: "mock",
    deliveryResults: [],
  };
  // Ensure the vellum anchor binding exists and return its principal
  return ensureVellumGuardianBinding("self");
}

async function flushAsyncAccessRequestBookkeeping(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function buildInboundRequest(overrides: Record<string, unknown> = {}): Request {
  const body: Record<string, unknown> = {
    sourceChannel: "telegram",
    interface: "telegram",
    conversationExternalId: "chat-123",
    externalMessageId: `msg-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    content: "Hello, can I use this assistant?",
    actorExternalId: "user-unknown-456",
    actorDisplayName: "Alice Unknown",
    actorUsername: "alice_unknown",
    replyCallbackUrl: "http://localhost:7830/deliver/telegram",
    ...overrides,
  };

  return new Request("http://localhost:8080/channels/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Origin": TEST_BEARER_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("non-member access request notification", () => {
  let anchorPrincipalId: string;
  beforeEach(() => {
    anchorPrincipalId = resetState();
  });

  test("non-member message is denied with rejection reply", async () => {
    const req = buildInboundRequest();
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.denied).toBe(true);
    expect(json.reason).toBe("not_a_member");

    // Rejection reply was delivered — always-notify behavior means the reply
    // indicates the guardian will be notified, even without a same-channel binding.
    expect(deliverReplyCalls.length).toBe(1);
    expect(
      (deliverReplyCalls[0].payload as Record<string, unknown>).text,
    ).toContain("let them know");
  });

  test("guardian is notified when a non-member messages and a guardian binding exists", async () => {
    // Set up a guardian binding for this channel using the anchor principal
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-789",
      guardianDeliveryChatId: "guardian-chat-789",
      guardianPrincipalId: anchorPrincipalId,
      verifiedVia: "test",
    });

    const req = buildInboundRequest();
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    // Message is still denied
    expect(json.denied).toBe(true);
    expect(json.reason).toBe("not_a_member");

    // Rejection reply was delivered
    expect(deliverReplyCalls.length).toBe(1);

    // A notification signal was emitted
    expect(emitSignalCalls.length).toBe(1);
    expect(emitSignalCalls[0].sourceEventName).toBe("ingress.access_request");
    expect(emitSignalCalls[0].sourceChannel).toBe("telegram");
    const payload = emitSignalCalls[0].contextPayload as Record<
      string,
      unknown
    >;
    expect(payload.actorExternalId).toBe("user-unknown-456");
    expect(payload.actorDisplayName).toBe("Alice Unknown");

    // A canonical access request was created
    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "user-unknown-456",
      sourceChannel: "telegram",
      kind: "access_request",
    });
    expect(pending.length).toBe(1);
    expect(pending[0].status).toBe("pending");
    expect(pending[0].requesterExternalUserId).toBe("user-unknown-456");
    expect(pending[0].guardianExternalUserId).toBe("guardian-user-789");
    expect(pending[0].toolName).toBe("ingress_access_request");
  });

  test("no duplicate approval requests for repeated messages from same non-member", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-789",
      guardianDeliveryChatId: "guardian-chat-789",
      guardianPrincipalId: anchorPrincipalId,
      verifiedVia: "test",
    });

    // First message
    const req1 = buildInboundRequest();
    await handleChannelInbound(req1, undefined, TEST_BEARER_TOKEN);

    // Second message from the same user
    const req2 = buildInboundRequest({
      externalMessageId: `msg-second-${Date.now()}`,
      content: "Please let me in!",
    });
    await handleChannelInbound(req2, undefined, TEST_BEARER_TOKEN);

    // Both messages should be denied with rejection replies
    expect(deliverReplyCalls.length).toBe(2);

    // Only one notification signal should be emitted (second is deduplicated)
    expect(emitSignalCalls.length).toBe(1);

    // Only one canonical request should exist
    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "user-unknown-456",
      sourceChannel: "telegram",
      kind: "access_request",
    });
    expect(pending.length).toBe(1);
  });

  test("access request is created with self-healed principal even without same-channel guardian binding", async () => {
    // No guardian binding on any channel — self-heal creates a vellum binding
    // so the access_request (now decisionable) has a guardianPrincipalId.
    const req = buildInboundRequest();
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.denied).toBe(true);
    expect(json.reason).toBe("not_a_member");

    // Rejection reply indicates guardian was notified
    expect(deliverReplyCalls.length).toBe(1);
    expect(
      (deliverReplyCalls[0].payload as Record<string, unknown>).text,
    ).toContain("let them know");

    // Notification signal was emitted
    expect(emitSignalCalls.length).toBe(1);
    expect(emitSignalCalls[0].sourceEventName).toBe("ingress.access_request");

    // Canonical request was created with a self-healed principal
    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "user-unknown-456",
      sourceChannel: "telegram",
      kind: "access_request",
    });
    expect(pending.length).toBe(1);
    // Self-heal bootstraps a vellum binding — guardianExternalUserId is now set
    expect(pending[0].guardianExternalUserId).toBeDefined();
    expect(pending[0].guardianPrincipalId).toBeDefined();
  });

  test("non-source-channel binding falls back to vellum anchor for Telegram access request", async () => {
    // Only a voice guardian binding exists — no Telegram binding.
    // Since cross-channel fallback was removed, the access request resolves
    // to the assistant's vellum anchor identity instead.
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "guardian-voice-user",
      guardianDeliveryChatId: "guardian-voice-chat",
      guardianPrincipalId: anchorPrincipalId,
      verifiedVia: "test",
    });

    const req = buildInboundRequest();
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    const json = (await resp.json()) as Record<string, unknown>;

    expect(json.denied).toBe(true);
    expect(json.reason).toBe("not_a_member");

    // Notification signal emitted
    expect(emitSignalCalls.length).toBe(1);
    const payload = emitSignalCalls[0].contextPayload as Record<
      string,
      unknown
    >;
    // Falls back to vellum anchor, not the phone binding
    expect(payload.guardianBindingChannel).toBe("vellum");

    // Canonical request uses the vellum anchor identity
    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "user-unknown-456",
      sourceChannel: "telegram",
      kind: "access_request",
    });
    expect(pending.length).toBe(1);
    expect(pending[0].guardianPrincipalId).toBe(anchorPrincipalId);
  });

  test("no notification when actorExternalId is absent", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-789",
      guardianDeliveryChatId: "guardian-chat-789",
      guardianPrincipalId: anchorPrincipalId,
      verifiedVia: "test",
    });

    // Message without actorExternalId — the handler returns BAD_REQUEST.
    const req = buildInboundRequest({
      actorExternalId: undefined,
    });
    const resp = await handleChannelInbound(req, undefined, TEST_BEARER_TOKEN);
    expect(resp.status).toBe(400);

    // No access request notification should fire (no identity to notify about)
    expect(emitSignalCalls.length).toBe(0);
  });
});

describe("access-request-helper unit tests", () => {
  let anchorPrincipalId: string;
  beforeEach(() => {
    anchorPrincipalId = resetState();
  });

  test("notifyGuardianOfAccessRequest returns no_sender_id when actorExternalId is absent", () => {
    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "chat-123",
      actorExternalId: undefined,
    });

    expect(result.notified).toBe(false);
    if (!result.notified) {
      expect(result.reason).toBe("no_sender_id");
    }

    // No canonical request created
    const pending = listCanonicalGuardianRequests({
      status: "pending",
      kind: "access_request",
    });
    expect(pending.length).toBe(0);
  });

  test("notifyGuardianOfAccessRequest creates request with self-healed principal when no binding exists", () => {
    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "chat-123",
      actorExternalId: "unknown-user",
      actorDisplayName: "Bob",
    });

    expect(result.notified).toBe(true);
    if (result.notified) {
      expect(result.created).toBe(true);
    }

    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "unknown-user",
      kind: "access_request",
    });
    expect(pending.length).toBe(1);
    // Self-heal bootstraps a vellum binding
    expect(pending[0].guardianExternalUserId).toBeDefined();
    expect(pending[0].guardianPrincipalId).toBeDefined();

    // Signal was emitted
    expect(emitSignalCalls.length).toBe(1);
  });

  test("notifyGuardianOfAccessRequest falls back to assistant-anchored vellum identity when source-channel binding is missing", () => {
    // Only voice binding exists
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "guardian-voice",
      guardianDeliveryChatId: "voice-chat",
      guardianPrincipalId: "test-principal-id",
      verifiedVia: "test",
    });

    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "tg-chat",
      actorExternalId: "unknown-tg-user",
    });

    expect(result.notified).toBe(true);

    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "unknown-tg-user",
      kind: "access_request",
    });
    expect(pending.length).toBe(1);
    expect(pending[0].guardianPrincipalId).toBeDefined();

    // Signal payload includes anchored fallback channel
    const payload = emitSignalCalls[0].contextPayload as Record<
      string,
      unknown
    >;
    expect(payload.guardianBindingChannel).toBe("vellum");
  });

  test("notifyGuardianOfAccessRequest prefers source-channel binding over vellum anchor", () => {
    // Both Telegram and voice bindings exist with the anchor principal
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-tg",
      guardianDeliveryChatId: "tg-chat",
      guardianPrincipalId: anchorPrincipalId,
      verifiedVia: "test",
    });
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "guardian-voice",
      guardianDeliveryChatId: "voice-chat",
      guardianPrincipalId: anchorPrincipalId,
      verifiedVia: "test",
    });

    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "chat-123",
      actorExternalId: "unknown-user",
    });

    expect(result.notified).toBe(true);

    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "unknown-user",
      kind: "access_request",
    });
    expect(pending.length).toBe(1);
    // Should use the Telegram binding, not the vellum anchor
    expect(pending[0].guardianExternalUserId).toBe("guardian-tg");

    const payload = emitSignalCalls[0].contextPayload as Record<
      string,
      unknown
    >;
    expect(payload.guardianBindingChannel).toBe("telegram");
  });

  test("notifyGuardianOfAccessRequest for voice channel includes actorDisplayName in contextPayload", () => {
    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "phone",
      conversationExternalId: "+15559998888",
      actorExternalId: "+15559998888",
      actorDisplayName: "Alice Caller",
    });

    expect(result.notified).toBe(true);
    expect(emitSignalCalls.length).toBe(1);

    const payload = emitSignalCalls[0].contextPayload as Record<
      string,
      unknown
    >;
    expect(payload.sourceChannel).toBe("phone");
    expect(payload.actorDisplayName).toBe("Alice Caller");
    expect(payload.actorExternalId).toBe("+15559998888");
    expect(payload.senderIdentifier).toBe("Alice Caller");

    // Canonical request should exist
    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "+15559998888",
      sourceChannel: "phone",
      kind: "access_request",
    });
    expect(pending.length).toBe(1);
  });

  test("notifyGuardianOfAccessRequest includes requestCode in contextPayload", () => {
    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "chat-123",
      actorExternalId: "unknown-user",
      actorDisplayName: "Test User",
    });

    expect(result.notified).toBe(true);
    expect(emitSignalCalls.length).toBe(1);

    const payload = emitSignalCalls[0].contextPayload as Record<
      string,
      unknown
    >;
    expect(payload.requestCode).toBeDefined();
    expect(typeof payload.requestCode).toBe("string");
    expect((payload.requestCode as string).length).toBe(6);
  });

  test("notifyGuardianOfAccessRequest includes previousMemberStatus in contextPayload", () => {
    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "chat-123",
      actorExternalId: "revoked-user",
      actorDisplayName: "Revoked User",
      previousMemberStatus: "revoked",
    });

    expect(result.notified).toBe(true);
    expect(emitSignalCalls.length).toBe(1);

    const payload = emitSignalCalls[0].contextPayload as Record<
      string,
      unknown
    >;
    expect(payload.previousMemberStatus).toBe("revoked");
  });

  test("notifyGuardianOfAccessRequest persists canonical delivery rows from notification results", async () => {
    mockEmitResult = {
      signalId: "sig-deliveries",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [
        {
          channel: "vellum",
          destination: "vellum",
          status: "sent",
          conversationId: "conv-guardian-access-request",
        },
        {
          channel: "telegram",
          destination: "guardian-chat-123",
          status: "sent",
        },
      ],
    };

    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "phone",
      conversationExternalId: "+15556667777",
      actorExternalId: "+15556667777",
      actorDisplayName: "Noah",
    });

    expect(result.notified).toBe(true);
    if (!result.notified) return;

    await flushAsyncAccessRequestBookkeeping();

    const deliveries = listCanonicalGuardianDeliveries(result.requestId);
    const vellum = deliveries.find((d) => d.destinationChannel === "vellum");
    const telegram = deliveries.find(
      (d) => d.destinationChannel === "telegram",
    );

    expect(vellum).toBeDefined();
    expect(vellum!.destinationConversationId).toBe(
      "conv-guardian-access-request",
    );
    expect(vellum!.status).toBe("sent");
    expect(telegram).toBeDefined();
    expect(telegram!.destinationChatId).toBe("guardian-chat-123");
    expect(telegram!.status).toBe("sent");
  });

  test("notifyGuardianOfAccessRequest skips vellum fallback for same-channel-only routing (telegram)", async () => {
    // Set up a telegram guardian binding with the anchor principal so
    // guardianResolutionSource resolves to "source-channel-contact" and
    // sameChannelOnly is true.
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-456",
      guardianDeliveryChatId: "guardian-chat-456",
      guardianPrincipalId: anchorPrincipalId,
      verifiedVia: "test",
    });

    mockEmitResult = {
      signalId: "sig-no-vellum",
      deduplicated: false,
      dispatched: true,
      reason: "telegram-only",
      deliveryResults: [
        {
          channel: "telegram",
          destination: "guardian-chat-456",
          status: "sent",
        },
      ],
    };

    const result = notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "chat-123",
      actorExternalId: "unknown-user",
      actorDisplayName: "Alice",
    });

    expect(result.notified).toBe(true);
    if (!result.notified) return;

    await flushAsyncAccessRequestBookkeeping();

    const deliveries = listCanonicalGuardianDeliveries(result.requestId);
    const vellum = deliveries.find((d) => d.destinationChannel === "vellum");
    const telegram = deliveries.find(
      (d) => d.destinationChannel === "telegram",
    );

    // Guardian IS verified on telegram → sameChannelOnly, no vellum fallback
    expect(vellum).toBeUndefined();
    expect(telegram).toBeDefined();
    expect(telegram!.destinationChatId).toBe("guardian-chat-456");
    expect(telegram!.status).toBe("sent");
  });
});
