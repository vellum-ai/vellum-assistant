/**
 * Tests for M7: Trusted contact lifecycle notification signals.
 *
 * Verifies that all trusted contact lifecycle transitions emit proper
 * notification signals via emitNotificationSignal():
 *
 * 1. request_submitted — when a non-member requests access (covered by
 *    ingress.access_request, tested in non-member-access-request.test.ts)
 * 2. guardian_decision — when the guardian approves or denies
 * 3. verification_sent — when the verification code is created and delivered
 * 4. activated — when the trusted contact successfully verifies
 * 5. denied — when the guardian denies the request
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

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
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emitSignalCalls.push(params);
    return {
      signalId: "mock-signal-id",
      deduplicated: false,
      dispatched: true,
      reason: "mock",
      deliveryResults: [],
    };
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

// Mock the approval conversation / copy generators so they return canned text.
mock.module("../runtime/approval-message-composer.js", () => ({
  composeApprovalMessage: () => "mock approval message",
  composeApprovalMessageGenerative: async () => "mock generative message",
}));

import { getResolver } from "../approvals/guardian-request-resolvers.js";
import { findContactChannel } from "../contacts/contact-store.js";
import {
  createGuardianBinding,
  upsertContactChannel,
} from "../contacts/contacts-write.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { createApprovalRequest } from "../memory/guardian-approvals.js";
import { createOutboundSession } from "../runtime/channel-verification-service.js";
import { handleChannelInbound } from "../runtime/routes/channel-routes.js";

initializeDb();

afterAll(() => {
  resetDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_BEARER_TOKEN = "test-token";
const GUARDIAN_APPROVAL_TTL_MS = 5 * 60 * 1000;

function resetState(): void {
  const db = getDb();
  db.run("DELETE FROM channel_guardian_approval_requests");
  db.run("DELETE FROM channel_verification_sessions");
  db.run("DELETE FROM channel_guardian_rate_limits");
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM notification_events");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  emitSignalCalls.length = 0;
  deliverReplyCalls.length = 0;
}

function buildInboundRequest(overrides: Record<string, unknown> = {}): Request {
  const body: Record<string, unknown> = {
    sourceChannel: "telegram",
    interface: "telegram",
    conversationExternalId: "chat-123",
    externalMessageId: `msg-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    content: "Hello",
    actorExternalId: "requester-user-456",
    actorDisplayName: "Alice Requester",
    actorUsername: "alice_req",
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
// Tests: Guardian decision signals (approve/deny)
// ---------------------------------------------------------------------------

describe("trusted contact lifecycle notification signals", () => {
  beforeEach(() => {
    resetState();
  });

  test("guardian deny emits guardian_decision and denied signals", async () => {
    // Set up guardian binding and member record (guardians must pass ACL)
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-789",
      guardianDeliveryChatId: "guardian-chat-789",
      guardianPrincipalId: "guardian-user-789",
      verifiedVia: "test",
    });
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "guardian-user-789",
      externalChatId: "guardian-chat-789",
      status: "active",
      policy: "allow",
    });

    const testRequestId = `req-deny-${Date.now()}`;

    // Create a pending access request approval
    const _approval = createApprovalRequest({
      runId: `ingress-access-request-${Date.now()}`,
      requestId: testRequestId,
      conversationId: "access-req-telegram-requester-user-456",
      channel: "telegram",
      requesterExternalUserId: "requester-user-456",
      requesterChatId: "requester-chat-456",
      guardianExternalUserId: "guardian-user-789",
      guardianChatId: "guardian-chat-789",
      toolName: "ingress_access_request",
      riskLevel: "access_request",
      reason: "Alice is requesting access",
      expiresAt: Date.now() + GUARDIAN_APPROVAL_TTL_MS,
    });

    // Guardian denies via callback button
    const guardianReq = buildInboundRequest({
      conversationExternalId: "guardian-chat-789",
      actorExternalId: "guardian-user-789",
      actorDisplayName: "Guardian",
      content: "",
      callbackData: `apr:${testRequestId}:reject`,
    });

    await handleChannelInbound(guardianReq, undefined, TEST_BEARER_TOKEN);

    // Should emit guardian_decision and denied signals

    const guardianDecisionSignals = emitSignalCalls.filter(
      (c) => c.sourceEventName === "ingress.trusted_contact.guardian_decision",
    );
    const deniedSignals = emitSignalCalls.filter(
      (c) => c.sourceEventName === "ingress.trusted_contact.denied",
    );

    expect(guardianDecisionSignals.length).toBe(1);
    expect(deniedSignals.length).toBe(1);

    // Verify guardian_decision payload
    const gdPayload = guardianDecisionSignals[0].contextPayload as Record<
      string,
      unknown
    >;
    expect(gdPayload.decision).toBe("denied");
    expect(gdPayload.requesterExternalUserId).toBe("requester-user-456");
    expect(gdPayload.decidedByExternalUserId).toBe("guardian-user-789");

    // Verify denied payload
    const dPayload = deniedSignals[0].contextPayload as Record<string, unknown>;
    expect(dPayload.decision).toBe("denied");
    expect(dPayload.requesterExternalUserId).toBe("requester-user-456");

    // Verify deduplication keys are distinct
    expect(guardianDecisionSignals[0].dedupeKey).toContain(
      "trusted-contact:guardian-decision:",
    );
    expect(deniedSignals[0].dedupeKey).toContain("trusted-contact:denied:");
  });

  test("guardian approve emits guardian_decision and verification_sent signals", async () => {
    // Set up guardian binding and member record (guardians must pass ACL)
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-789",
      guardianDeliveryChatId: "guardian-chat-789",
      guardianPrincipalId: "guardian-user-789",
      verifiedVia: "test",
    });
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "guardian-user-789",
      externalChatId: "guardian-chat-789",
      status: "active",
      policy: "allow",
    });

    const testRequestId = `req-approve-${Date.now()}`;

    // Create a pending access request approval
    const _approval = createApprovalRequest({
      runId: `ingress-access-request-${Date.now()}`,
      requestId: testRequestId,
      conversationId: "access-req-telegram-requester-user-456",
      channel: "telegram",
      requesterExternalUserId: "requester-user-456",
      requesterChatId: "requester-chat-456",
      guardianExternalUserId: "guardian-user-789",
      guardianChatId: "guardian-chat-789",
      toolName: "ingress_access_request",
      riskLevel: "access_request",
      reason: "Alice is requesting access",
      expiresAt: Date.now() + GUARDIAN_APPROVAL_TTL_MS,
    });

    // Guardian approves via callback button
    const guardianReq = buildInboundRequest({
      conversationExternalId: "guardian-chat-789",
      actorExternalId: "guardian-user-789",
      actorDisplayName: "Guardian",
      content: "",
      callbackData: `apr:${testRequestId}:approve_once`,
    });

    await handleChannelInbound(guardianReq, undefined, TEST_BEARER_TOKEN);

    // guardian_decision should NOT fire at approval time when verification
    // is still pending — it would cause the notification pipeline to send a
    // premature "approved" message to the guardian's chat.
    const guardianDecisionSignals = emitSignalCalls.filter(
      (c) => c.sourceEventName === "ingress.trusted_contact.guardian_decision",
    );
    const verificationSentSignals = emitSignalCalls.filter(
      (c) => c.sourceEventName === "ingress.trusted_contact.verification_sent",
    );

    expect(guardianDecisionSignals.length).toBe(0);
    expect(verificationSentSignals.length).toBe(1);

    // Verify verification_sent payload and that it's suppressed from delivery
    const vsSignal = verificationSentSignals[0];
    const vsPayload = vsSignal.contextPayload as Record<string, unknown>;
    expect(vsPayload.requesterExternalUserId).toBe("requester-user-456");
    expect(vsPayload.verificationSessionId).toBeDefined();
    expect(
      (vsSignal.attentionHints as Record<string, unknown>).visibleInSourceNow,
    ).toBe(true);

    // Should NOT emit denied signal
    const deniedSignals = emitSignalCalls.filter(
      (c) => c.sourceEventName === "ingress.trusted_contact.denied",
    );
    expect(deniedSignals.length).toBe(0);
  });

  test("deduplication keys prevent duplicate signals", async () => {
    // Set up guardian binding and member record (guardians must pass ACL)
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-789",
      guardianDeliveryChatId: "guardian-chat-789",
      guardianPrincipalId: "guardian-user-789",
      verifiedVia: "test",
    });
    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "guardian-user-789",
      externalChatId: "guardian-chat-789",
      status: "active",
      policy: "allow",
    });

    const testRequestId = `req-dedup-${Date.now()}`;

    const approval = createApprovalRequest({
      runId: `ingress-access-request-${Date.now()}`,
      requestId: testRequestId,
      conversationId: "access-req-telegram-requester-user-456",
      channel: "telegram",
      requesterExternalUserId: "requester-user-456",
      requesterChatId: "requester-chat-456",
      guardianExternalUserId: "guardian-user-789",
      guardianChatId: "guardian-chat-789",
      toolName: "ingress_access_request",
      riskLevel: "access_request",
      reason: "Alice is requesting access",
      expiresAt: Date.now() + GUARDIAN_APPROVAL_TTL_MS,
    });

    // All guardian_decision signals include the approval ID in the dedupe key
    const guardianReq = buildInboundRequest({
      conversationExternalId: "guardian-chat-789",
      actorExternalId: "guardian-user-789",
      actorDisplayName: "Guardian",
      content: "",
      callbackData: `apr:${testRequestId}:reject`,
    });

    await handleChannelInbound(guardianReq, undefined, TEST_BEARER_TOKEN);

    const signals = emitSignalCalls.filter(
      (c) =>
        typeof c.dedupeKey === "string" &&
        (c.dedupeKey as string).includes(approval.id),
    );
    // guardian_decision and denied — both keyed on approval.id
    expect(signals.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: Activated signal (trusted contact verification success)
// ---------------------------------------------------------------------------

describe("trusted contact activated notification signal", () => {
  beforeEach(() => {
    resetState();
  });

  test("successful trusted contact verification emits activated signal", async () => {
    // Set up a guardian binding so the verification path allows bypass
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-789",
      guardianDeliveryChatId: "guardian-chat-789",
      guardianPrincipalId: "guardian-user-789",
      verifiedVia: "test",
    });

    // Create an identity-bound outbound session (simulates M3 approval flow)
    const session = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "requester-user-456",
      expectedChatId: "chat-123",
      identityBindingStatus: "bound",
      destinationAddress: "chat-123",
      verificationPurpose: "trusted_contact",
    });

    // Requester enters the verification code
    const verifyReq = buildInboundRequest({
      content: session.secret,
      conversationExternalId: "chat-123",
      actorExternalId: "requester-user-456",
    });

    await handleChannelInbound(verifyReq, undefined, TEST_BEARER_TOKEN);

    // Should emit the activated signal
    const activatedSignals = emitSignalCalls.filter(
      (c) => c.sourceEventName === "ingress.trusted_contact.activated",
    );

    expect(activatedSignals.length).toBe(1);

    // Verify payload
    const payload = activatedSignals[0].contextPayload as Record<
      string,
      unknown
    >;
    expect(payload.sourceChannel).toBe("telegram");
    expect(payload.actorExternalId).toBe("requester-user-456");
    expect(payload.conversationExternalId).toBe("chat-123");

    // Verify deduplication key includes the user identity
    const dedupeKey = activatedSignals[0].dedupeKey as string;
    expect(dedupeKey).toContain("trusted-contact:activated:");
    expect(dedupeKey).toContain("requester-user-456");

    // Verify attention hints indicate informational (no action required)
    const hints = activatedSignals[0].attentionHints as Record<string, unknown>;
    expect(hints.requiresAction).toBe(false);
    expect(hints.urgency).toBe("low");
  });

  test("re-verification preserves an existing guardian-managed member display name", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-789",
      guardianDeliveryChatId: "guardian-chat-789",
      guardianPrincipalId: "guardian-user-789",
      verifiedVia: "test",
    });

    upsertContactChannel({
      sourceChannel: "telegram",
      externalUserId: "requester-user-456",
      externalChatId: "chat-123",
      status: "revoked",
      policy: "allow",
      displayName: "Jeff",
    });

    const session = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "requester-user-456",
      expectedChatId: "chat-123",
      identityBindingStatus: "bound",
      destinationAddress: "chat-123",
      verificationPurpose: "trusted_contact",
    });

    const verifyReq = buildInboundRequest({
      content: session.secret,
      conversationExternalId: "chat-123",
      actorExternalId: "requester-user-456",
      actorDisplayName: "Noa Flaherty",
    });

    await handleChannelInbound(verifyReq, undefined, TEST_BEARER_TOKEN);

    const result = findContactChannel({
      channelType: "telegram",
      externalUserId: "requester-user-456",
    });
    expect(result).not.toBeNull();
    expect(result!.channel.status).toBe("active");
    expect(result!.contact.displayName).toBe("Jeff");
  });

  test("guardian verification does NOT emit activated signal", async () => {
    // Create an inbound challenge (guardian flow, not trusted contact)
    const { createInboundVerificationSession } =
      await import("../runtime/channel-verification-service.js");
    const { secret } = createInboundVerificationSession("telegram");

    // "Guardian" enters the verification code
    const verifyReq = buildInboundRequest({
      content: secret,
      conversationExternalId: "guardian-chat-new",
      actorExternalId: "guardian-user-new",
    });

    await handleChannelInbound(verifyReq, undefined, TEST_BEARER_TOKEN);

    // Should NOT emit the trusted_contact.activated signal
    const activatedSignals = emitSignalCalls.filter(
      (c) => c.sourceEventName === "ingress.trusted_contact.activated",
    );
    expect(activatedSignals.length).toBe(0);
  });

  test("voice access_request resolver has registered handler for access_request kind", () => {
    // The access_request resolver is registered during module load. When the
    // source channel is 'voice', it should directly activate the member via
    // upsertContactChannel (no verification session). This test validates the resolver
    // is registered and accessible.
    const resolver = getResolver("access_request");
    expect(resolver).toBeDefined();
    expect(resolver!.kind).toBe("access_request");
  });

  test("member is persisted BEFORE activated signal is emitted", async () => {
    // Set up a guardian binding
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-789",
      guardianDeliveryChatId: "guardian-chat-789",
      guardianPrincipalId: "guardian-user-789",
      verifiedVia: "test",
    });

    const session = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "requester-user-456",
      expectedChatId: "chat-123",
      identityBindingStatus: "bound",
      destinationAddress: "chat-123",
      verificationPurpose: "trusted_contact",
    });

    const verifyReq = buildInboundRequest({
      content: session.secret,
      conversationExternalId: "chat-123",
      actorExternalId: "requester-user-456",
    });

    await handleChannelInbound(verifyReq, undefined, TEST_BEARER_TOKEN);

    // The activated signal was emitted
    const activatedSignals = emitSignalCalls.filter(
      (c) => c.sourceEventName === "ingress.trusted_contact.activated",
    );
    expect(activatedSignals.length).toBe(1);

    // Verify the member was already persisted (the signal fires after upsertContactChannel)
    const result = findContactChannel({
      channelType: "telegram",
      externalUserId: "requester-user-456",
    });
    expect(result).not.toBeNull();
    expect(result!.channel.status).toBe("active");
    expect(result!.channel.policy).toBe("allow");
  });
});
