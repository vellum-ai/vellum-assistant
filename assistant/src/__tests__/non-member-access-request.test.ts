/**
 * Tests for the non-member access request notification flow.
 *
 * When a non-member messages the assistant on a channel, the system should:
 * 1. Deny the message with the standard rejection reply
 * 2. Notify the guardian (if a guardian binding exists)
 * 3. Create a guardian approval request for the access request
 * 4. Deduplicate: don't create duplicate requests for repeated messages
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

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

// Guardian identity for the access request resolves via the gateway delivery
// reader, not the local contacts DB. Seed it per-test via seedGatewayGuardian.
interface GatewayGuardian {
  channelType: string;
  contactId: string;
  principalId?: string | null;
  displayName?: string | null;
  address: string;
  externalChatId?: string | null;
  status: string;
  verifiedAt?: number | null;
}
let gatewayGuardians: GatewayGuardian[] = [];
mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => gatewayGuardians,
  guardianForChannel: (list: GatewayGuardian[], channelType: string) =>
    list.find((g) => g.channelType === channelType && g.status === "active"),
}));

function seedGatewayGuardian(
  g: Partial<GatewayGuardian> & {
    channelType: string;
    address: string;
  },
): void {
  gatewayGuardians.push({
    contactId: `c-${g.channelType}`,
    status: "active",
    ...g,
  });
}

import {
  createCanonicalGuardianRequest,
  listCanonicalGuardianDeliveries,
  listCanonicalGuardianRequests,
  resolveCanonicalGuardianRequest,
} from "../contacts/canonical-guardian-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  isAccessRequestDenied,
  maybeNotifyGuardianOfAdmittedContact,
  notifyGuardianOfAccessRequest,
} from "../runtime/access-request-helper.js";
import { handleChannelInbound } from "./helpers/channel-test-adapter.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";

await initializeDb();

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
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM notification_events");
  db.run("DELETE FROM canonical_guardian_requests");
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  emitSignalCalls.length = 0;
  deliverReplyCalls.length = 0;
  gatewayGuardians = [];
  mockEmitResult = {
    signalId: "mock-signal-id",
    deduplicated: false,
    dispatched: true,
    reason: "mock",
    deliveryResults: [],
  };
  // Seed the vellum anchor binding in the gateway list (gateway does this at
  // startup in production). The DB write mirrors it for any local INFO reads.
  const principalId = `vellum-principal-${crypto.randomUUID()}`;
  seedGatewayGuardian({
    channelType: "vellum",
    address: principalId,
    principalId,
    displayName: principalId,
  });
  createGuardianBinding({
    channel: "vellum",
    guardianExternalUserId: principalId,
    guardianDeliveryChatId: "local",
    guardianPrincipalId: principalId,
    verifiedVia: "bootstrap",
  });
  return principalId;
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
    ).toContain("know you tried talking to me");
  });

  test("guardian is notified when a non-member messages and a guardian binding exists", async () => {
    // Set up a guardian binding for this channel using the anchor principal
    seedGatewayGuardian({
      channelType: "telegram",
      address: "guardian-user-789",
      externalChatId: "guardian-chat-789",
      principalId: anchorPrincipalId,
    });
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
    seedGatewayGuardian({
      channelType: "telegram",
      address: "guardian-user-789",
      externalChatId: "guardian-chat-789",
      principalId: anchorPrincipalId,
    });
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

  // After the guardian denies an access request, subsequent DMs from the same
  // sender do not re-prompt the guardian. Drives the real inbound path for both
  // messages so the deny-dedup matches the exact assistant-scoped
  // conversationId the notify path derives — a hand-crafted fixture could mask
  // a mismatch.
  test("a denied sender's subsequent DM does not re-prompt the guardian", async () => {
    seedGatewayGuardian({
      channelType: "telegram",
      address: "guardian-user-789",
      externalChatId: "guardian-chat-789",
      principalId: anchorPrincipalId,
    });
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-789",
      guardianDeliveryChatId: "guardian-chat-789",
      guardianPrincipalId: anchorPrincipalId,
      verifiedVia: "test",
    });

    // 1) First DM from the unknown sender → guardian is prompted once.
    await handleChannelInbound(
      buildInboundRequest(),
      undefined,
      TEST_BEARER_TOKEN,
    );
    expect(emitSignalCalls.length).toBe(1);

    const created = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "user-unknown-456",
      sourceChannel: "telegram",
      kind: "access_request",
    });
    expect(created.length).toBe(1);

    // 2) Guardian denies — resolve the *real* request (same CAS transition the
    // deny primitive performs), preserving its conversationId.
    const denied = resolveCanonicalGuardianRequest(created[0].id, "pending", {
      status: "denied",
      decidedByExternalUserId: "guardian-user-789",
    });
    expect(denied?.status).toBe("denied");

    // 3) Same sender DMs again → still denied, but NO new guardian prompt.
    const resp2 = await handleChannelInbound(
      buildInboundRequest({
        externalMessageId: `msg-after-deny-${Date.now()}`,
      }),
      undefined,
      TEST_BEARER_TOKEN,
    );
    const json2 = (await resp2.json()) as Record<string, unknown>;
    expect(json2.denied).toBe(true);

    // No additional access-request signal was emitted (still just the first).
    expect(emitSignalCalls.length).toBe(1);

    // And no fresh pending request was created for the denied sender.
    const pendingAfter = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "user-unknown-456",
      sourceChannel: "telegram",
      kind: "access_request",
    });
    expect(pendingAfter.length).toBe(0);
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
    ).toContain("know you tried talking to me");

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
    seedGatewayGuardian({
      channelType: "phone",
      address: "guardian-voice-user",
      externalChatId: "guardian-voice-chat",
      principalId: anchorPrincipalId,
    });
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

  test("notifyGuardianOfAccessRequest returns no_sender_id when actorExternalId is absent", async () => {
    const result = await notifyGuardianOfAccessRequest({
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

  test("notifyGuardianOfAccessRequest creates request with self-healed principal when no binding exists", async () => {
    const result = await notifyGuardianOfAccessRequest({
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

  test("notifyGuardianOfAccessRequest falls back to assistant-anchored vellum identity when source-channel binding is missing", async () => {
    // Only voice binding exists
    seedGatewayGuardian({
      channelType: "phone",
      address: "guardian-voice",
      externalChatId: "voice-chat",
      principalId: "test-principal-id",
    });
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "guardian-voice",
      guardianDeliveryChatId: "voice-chat",
      guardianPrincipalId: "test-principal-id",
      verifiedVia: "test",
    });

    const result = await notifyGuardianOfAccessRequest({
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

  test("notifyGuardianOfAccessRequest prefers source-channel binding over vellum anchor", async () => {
    // Both Telegram and voice bindings exist with the anchor principal
    seedGatewayGuardian({
      channelType: "telegram",
      address: "guardian-tg",
      externalChatId: "tg-chat",
      principalId: anchorPrincipalId,
    });
    seedGatewayGuardian({
      channelType: "phone",
      address: "guardian-voice",
      externalChatId: "voice-chat",
      principalId: anchorPrincipalId,
    });
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

    const result = await notifyGuardianOfAccessRequest({
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

  test("notifyGuardianOfAccessRequest resolves the source-channel guardian from the gateway delivery", async () => {
    // Gateway delivery serves a telegram guardian matching the vellum anchor.
    seedGatewayGuardian({
      channelType: "telegram",
      address: "guardian-tg",
      externalChatId: "tg-chat",
      principalId: anchorPrincipalId,
    });
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-tg",
      guardianDeliveryChatId: "tg-chat",
      guardianPrincipalId: anchorPrincipalId,
      verifiedVia: "test",
    });

    const result = await notifyGuardianOfAccessRequest({
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
    // Request is decidable: gateway delivery supplied the principal + source binding.
    expect(pending[0].guardianPrincipalId).toBe(anchorPrincipalId);
    expect(pending[0].guardianExternalUserId).toBe("guardian-tg");

    const payload = emitSignalCalls[0].contextPayload as Record<
      string,
      unknown
    >;
    expect(payload.guardianBindingChannel).toBe("telegram");
  });

  test("notifyGuardianOfAccessRequest resolves the vellum anchor from the gateway delivery", async () => {
    // Only the vellum anchor (seeded in resetState) is served by the gateway.
    const result = await notifyGuardianOfAccessRequest({
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
    // Decidable via the gateway-served vellum anchor principal.
    expect(pending[0].guardianPrincipalId).toBe(anchorPrincipalId);

    const payload = emitSignalCalls[0].contextPayload as Record<
      string,
      unknown
    >;
    expect(payload.guardianBindingChannel).toBe("vellum");
  });

  test("notifyGuardianOfAccessRequest does not create a decisionable request when the gateway delivery is empty", async () => {
    // Genuinely unbound assistant: gateway serves no guardian. The guard
    // rejects creation of a decisionable request without a principal.
    gatewayGuardians = [];
    const db = getDb();
    db.run("DELETE FROM contact_channels");
    db.run("DELETE FROM contacts");

    await expect(
      notifyGuardianOfAccessRequest({
        canonicalAssistantId: "self",
        sourceChannel: "telegram",
        conversationExternalId: "chat-123",
        actorExternalId: "unknown-user",
      }),
    ).rejects.toThrow();

    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "unknown-user",
      kind: "access_request",
    });
    expect(pending.length).toBe(0);
  });

  test("notifyGuardianOfAccessRequest for voice channel includes actorDisplayName in contextPayload", async () => {
    const result = await notifyGuardianOfAccessRequest({
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

  test("notifyGuardianOfAccessRequest includes requestCode in contextPayload", async () => {
    const result = await notifyGuardianOfAccessRequest({
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

  test("notifyGuardianOfAccessRequest includes previousMemberStatus in contextPayload", async () => {
    const result = await notifyGuardianOfAccessRequest({
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

    const result = await notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "phone",
      conversationExternalId: "+15556667777",
      actorExternalId: "+15556667777",
      actorDisplayName: "Noah",
    });

    expect(result.notified).toBe(true);
    if (!result.notified) {
      return;
    }

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
    seedGatewayGuardian({
      channelType: "telegram",
      address: "guardian-user-456",
      externalChatId: "guardian-chat-456",
      principalId: anchorPrincipalId,
    });
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

    const result = await notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "chat-123",
      actorExternalId: "unknown-user",
      actorDisplayName: "Alice",
    });

    expect(result.notified).toBe(true);
    if (!result.notified) {
      return;
    }

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

  test("notifyGuardianOfAccessRequest is suppressed after a prior deny for the same sender", async () => {
    // Simulate a previously-denied access request for this sender on this
    // channel/assistant. The conversationId must match the assistant-scoped
    // key the helper derives: access-req-<assistantId>-<channel>-<actor>.
    createCanonicalGuardianRequest({
      id: `denied-${Date.now()}`,
      kind: "access_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "access-req-self-telegram-denied-user",
      requesterExternalUserId: "denied-user",
      guardianPrincipalId: anchorPrincipalId,
      toolName: "ingress_access_request",
      status: "denied",
    });

    const result = await notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "chat-denied",
      actorExternalId: "denied-user",
      actorDisplayName: "Denied User",
    });

    // Suppressed: no new prompt, no signal, no new pending request.
    expect(result.notified).toBe(false);
    if (!result.notified) {
      expect(result.reason).toBe("already_denied");
    }
    expect(emitSignalCalls.length).toBe(0);

    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "denied-user",
      kind: "access_request",
    });
    expect(pending.length).toBe(0);
  });

  // LUM-2673: inside the post-approval verification window, inbound from the
  // sender must not create a new request or re-notify the guardian — the
  // handshake is waiting on the sender to enter their code.
  test("suppressed while the approval's verification window is open", async () => {
    createCanonicalGuardianRequest({
      id: `approved-${Date.now()}`,
      kind: "access_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "access-req-self-telegram-approved-user",
      requesterExternalUserId: "approved-user",
      guardianPrincipalId: anchorPrincipalId,
      toolName: "ingress_access_request",
      status: "approved",
    });

    const result = await notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "chat-approved",
      actorExternalId: "approved-user",
      actorDisplayName: "Approved User",
    });

    expect(result.notified).toBe(false);
    if (!result.notified) {
      expect(result.reason).toBe("approval_pending_verification");
    }
    expect(emitSignalCalls.length).toBe(0);

    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "approved-user",
      kind: "access_request",
    });
    expect(pending.length).toBe(0);
  });

  test("re-prompts once the approval's verification window has lapsed", async () => {
    const requestId = `approved-stale-${Date.now()}`;
    createCanonicalGuardianRequest({
      id: requestId,
      kind: "access_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "access-req-self-telegram-stale-user",
      requesterExternalUserId: "stale-user",
      guardianPrincipalId: anchorPrincipalId,
      toolName: "ingress_access_request",
      status: "approved",
    });
    // Age the approval decision past the verification-code TTL: the code can
    // no longer be redeemed, so the sender's next message legitimately
    // re-prompts the guardian.
    const staleUpdatedAt = Date.now() - 11 * 60 * 1000;
    getDb().run(
      sql`UPDATE canonical_guardian_requests SET updated_at = ${staleUpdatedAt} WHERE id = ${requestId}`,
    );

    const result = await notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "chat-stale",
      actorExternalId: "stale-user",
      actorDisplayName: "Stale User",
    });

    expect(result.notified).toBe(true);
    expect(emitSignalCalls.length).toBe(1);

    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "stale-user",
      kind: "access_request",
    });
    expect(pending.length).toBe(1);
  });

  test("a terminal deny wins over an in-window approval for the same sender", async () => {
    createCanonicalGuardianRequest({
      id: `approved-then-denied-a-${Date.now()}`,
      kind: "access_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "access-req-self-telegram-flip-user",
      requesterExternalUserId: "flip-user",
      guardianPrincipalId: anchorPrincipalId,
      toolName: "ingress_access_request",
      status: "approved",
    });
    createCanonicalGuardianRequest({
      id: `approved-then-denied-d-${Date.now()}`,
      kind: "access_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "access-req-self-telegram-flip-user",
      requesterExternalUserId: "flip-user",
      guardianPrincipalId: anchorPrincipalId,
      toolName: "ingress_access_request",
      status: "denied",
    });

    const result = await notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "chat-flip",
      actorExternalId: "flip-user",
      actorDisplayName: "Flip User",
    });

    expect(result.notified).toBe(false);
    if (!result.notified) {
      expect(result.reason).toBe("already_denied");
    }
    expect(emitSignalCalls.length).toBe(0);
  });

  test("a prior deny for one sender does not suppress prompts for a different sender", async () => {
    createCanonicalGuardianRequest({
      id: `denied-other-${Date.now()}`,
      kind: "access_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "access-req-self-telegram-denied-user",
      requesterExternalUserId: "denied-user",
      guardianPrincipalId: anchorPrincipalId,
      toolName: "ingress_access_request",
      status: "denied",
    });

    // A different sender still gets a fresh prompt.
    const result = await notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "telegram",
      conversationExternalId: "chat-fresh",
      actorExternalId: "fresh-user",
      actorDisplayName: "Fresh User",
    });

    expect(result.notified).toBe(true);
    expect(emitSignalCalls.length).toBe(1);

    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "fresh-user",
      kind: "access_request",
    });
    expect(pending.length).toBe(1);
  });

  test("a denied request on a different channel does not suppress a new channel's prompt", async () => {
    // Denied on telegram; the same actor id messaging on slack is a distinct
    // (channel-scoped) context and still surfaces to the guardian.
    createCanonicalGuardianRequest({
      id: `denied-tg-${Date.now()}`,
      kind: "access_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "access-req-self-telegram-cross-user",
      requesterExternalUserId: "cross-user",
      guardianPrincipalId: anchorPrincipalId,
      toolName: "ingress_access_request",
      status: "denied",
    });

    const result = await notifyGuardianOfAccessRequest({
      canonicalAssistantId: "self",
      sourceChannel: "slack",
      conversationExternalId: "C-cross",
      actorExternalId: "cross-user",
      actorDisplayName: "Cross User",
    });

    expect(result.notified).toBe(true);
    const pending = listCanonicalGuardianRequests({
      status: "pending",
      requesterExternalUserId: "cross-user",
      sourceChannel: "slack",
      kind: "access_request",
    });
    expect(pending.length).toBe(1);
  });

  test("isAccessRequestDenied is true only for the denied (assistant, channel, sender)", async () => {
    const key = {
      canonicalAssistantId: "self",
      sourceChannel: "telegram",
      actorExternalId: "denied-user",
    };
    expect(await isAccessRequestDenied(key)).toBe(false);

    createCanonicalGuardianRequest({
      id: `denied-${Date.now()}`,
      kind: "access_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "access-req-self-telegram-denied-user",
      requesterExternalUserId: "denied-user",
      guardianPrincipalId: anchorPrincipalId,
      toolName: "ingress_access_request",
      status: "denied",
    });

    expect(await isAccessRequestDenied(key)).toBe(true);
    // Scoped: a different channel or sender is not treated as denied.
    expect(
      await isAccessRequestDenied({ ...key, sourceChannel: "slack" }),
    ).toBe(false);
    expect(
      await isAccessRequestDenied({ ...key, actorExternalId: "other" }),
    ).toBe(false);
    // A still-pending request is not a terminal deny.
    createCanonicalGuardianRequest({
      id: `pending-${Date.now()}`,
      kind: "access_request",
      sourceType: "channel",
      sourceChannel: "telegram",
      conversationId: "access-req-self-telegram-pending-user",
      requesterExternalUserId: "pending-user",
      guardianPrincipalId: anchorPrincipalId,
      toolName: "ingress_access_request",
      status: "pending",
    });
    expect(
      await isAccessRequestDenied({ ...key, actorExternalId: "pending-user" }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Introduction nudge on first admit (maybeNotifyGuardianOfAdmittedContact)
// ---------------------------------------------------------------------------

describe("maybeNotifyGuardianOfAdmittedContact", () => {
  beforeEach(() => {
    resetState();
  });

  const baseParams = {
    canonicalAssistantId: "self",
    sourceChannel: "telegram" as const,
    conversationExternalId: "chat-123",
    actorExternalId: "user-unknown-456",
    actorDisplayName: "Alice Unknown",
  };

  test("first admit fires an admitted-mode introduction card", async () => {
    const result = await maybeNotifyGuardianOfAdmittedContact(baseParams);
    expect(result.notified).toBe(true);
    if (result.notified) {
      expect(result.created).toBe(true);
    }

    const requests = listCanonicalGuardianRequests({
      kind: "access_request",
      requesterExternalUserId: baseParams.actorExternalId,
    });
    expect(requests.length).toBe(1);
    expect(requests[0].questionText).toContain("was admitted");
    expect(requests[0].requesterChatId).toBe("chat-123");

    expect(emitSignalCalls.length).toBe(1);
    const signal = emitSignalCalls[0];
    expect((signal.contextPayload as Record<string, unknown>).trigger).toBe(
      "admitted",
    );
    expect((signal.attentionHints as Record<string, unknown>).urgency).toBe(
      "medium",
    );
  });

  test("second admit in the same conversation is suppressed once-ever", async () => {
    await maybeNotifyGuardianOfAdmittedContact(baseParams);
    const second = await maybeNotifyGuardianOfAdmittedContact(baseParams);

    expect(second.notified).toBe(false);
    if (!second.notified) {
      expect(second.reason).toBe("already_introduced");
    }
    expect(
      listCanonicalGuardianRequests({ kind: "access_request" }).length,
    ).toBe(1);
    expect(emitSignalCalls.length).toBe(1);
  });

  test("a live pending card from another conversation dedupes instead of double-carding", async () => {
    await maybeNotifyGuardianOfAdmittedContact(baseParams);
    const dm = await maybeNotifyGuardianOfAdmittedContact({
      ...baseParams,
      conversationExternalId: "dm-777",
    });

    // The per-conversation guard passes, but the actor-level pending dedupe
    // inside notifyGuardianOfAccessRequest keeps a single live card.
    expect(dm.notified).toBe(true);
    if (dm.notified) {
      expect(dm.created).toBe(false);
    }
    expect(
      listCanonicalGuardianRequests({ kind: "access_request" }).length,
    ).toBe(1);
  });

  test("after the earlier card expires undecided, a new conversation re-nudges once", async () => {
    await maybeNotifyGuardianOfAdmittedContact(baseParams);
    getDb().run("UPDATE canonical_guardian_requests SET status = 'expired'");

    const dm = await maybeNotifyGuardianOfAdmittedContact({
      ...baseParams,
      conversationExternalId: "dm-777",
    });
    expect(dm.notified).toBe(true);
    if (dm.notified) {
      expect(dm.created).toBe(true);
    }
    expect(
      listCanonicalGuardianRequests({ kind: "access_request" }).length,
    ).toBe(2);

    // The original conversation stays suppressed in every state.
    const original = await maybeNotifyGuardianOfAdmittedContact(baseParams);
    expect(original.notified).toBe(false);
    if (!original.notified) {
      expect(original.reason).toBe("already_introduced");
    }
  });

  test("a guardian terminal deny suppresses nudges across conversations", async () => {
    await maybeNotifyGuardianOfAdmittedContact(baseParams);
    getDb().run("UPDATE canonical_guardian_requests SET status = 'denied'");

    const dm = await maybeNotifyGuardianOfAdmittedContact({
      ...baseParams,
      conversationExternalId: "dm-777",
    });
    expect(dm.notified).toBe(false);
    if (!dm.notified) {
      expect(dm.reason).toBe("already_denied");
    }
  });

  test("returns no_sender_id without an actor id", async () => {
    const result = await maybeNotifyGuardianOfAdmittedContact({
      ...baseParams,
      actorExternalId: undefined,
    });
    expect(result.notified).toBe(false);
    if (!result.notified) {
      expect(result.reason).toBe("no_sender_id");
    }
    expect(
      listCanonicalGuardianRequests({ kind: "access_request" }).length,
    ).toBe(0);
  });

  test("deny-path requests keep high urgency and carry no trigger marker", async () => {
    await notifyGuardianOfAccessRequest(baseParams);
    expect(emitSignalCalls.length).toBe(1);
    const signal = emitSignalCalls[0];
    expect(
      "trigger" in (signal.contextPayload as Record<string, unknown>),
    ).toBe(false);
    expect((signal.attentionHints as Record<string, unknown>).urgency).toBe(
      "high",
    );
    const requests = listCanonicalGuardianRequests({
      kind: "access_request",
      requesterExternalUserId: baseParams.actorExternalId,
    });
    expect(requests[0].questionText).toContain("requesting access");
  });
});
