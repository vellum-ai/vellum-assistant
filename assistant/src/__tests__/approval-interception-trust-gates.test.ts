/**
 * Trust-class gates in `handleApprovalInterception`.
 *
 * The interception dispatcher applies identity-based gates before any decision
 * is resolved:
 *  - An unverified sender (no established identity) auto-denies a pending
 *    approval — a missing-identity actor must not be able to leave a sensitive
 *    request actionable.
 *  - An identity-known non-guardian must NOT auto-deny; it waits for the
 *    guardian and receives a "pending" notice.
 */

import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const _conversationMocks = new Map<string, unknown>();
mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (id: string) => _conversationMocks.get(id),
}));

// Anchored guardian principal, driven per-test to exercise the guardian
// principal gate (undefined = anchor unresolvable).
let _anchorPrincipalId: string | undefined;
mock.module("../runtime/local-actor-identity.js", () => ({
  findLocalGuardianPrincipalId: async () => _anchorPrincipalId,
}));

import type { Conversation } from "../daemon/conversation.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { initializeDb } from "../persistence/db-init.js";
import * as approvalMessageComposer from "../runtime/approval-message-composer.js";
import * as gatewayClient from "../runtime/gateway-client.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { handleApprovalInterception } from "../runtime/routes/guardian-approval-interception.js";

await initializeDb();

const ASSISTANT_ID = "self";
const CONVERSATION_ID = "conv-1";
const REQUESTER_CHAT = "requester-chat-1";
const TOOL_NAME = "execute_shell";
const TOOL_INPUT = { command: "rm -rf /tmp/test" };

function registerPendingInteraction(
  requestId: string,
  conversationId: string,
  toolName: string,
  input: Record<string, unknown> = TOOL_INPUT,
): ReturnType<typeof mock> {
  const handleConfirmationResponse = mock(() => {});
  const _mockSession = {
    handleConfirmationResponse,
    ensureActorScopedHistory: async () => {},
  } as unknown as Conversation;
  _conversationMocks.set(conversationId, _mockSession);

  pendingInteractions.register(requestId, {
    conversationId,
    kind: "confirmation",
    confirmationDetails: {
      toolName,
      input,
      riskLevel: "high",
      allowlistOptions: [
        { label: "test", description: "test", pattern: "test" },
      ],
      scopeOptions: [{ label: "everywhere", scope: "everywhere" }],
    },
  });

  return handleConfirmationResponse;
}

describe("approval interception trust-class gates", () => {
  let deliverSpy: ReturnType<typeof spyOn>;
  let composeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    pendingInteractions.clear();
    _anchorPrincipalId = undefined;
    deliverSpy = spyOn(gatewayClient, "deliverChannelReply").mockResolvedValue({
      ok: true,
    });
    composeSpy = spyOn(
      approvalMessageComposer,
      "composeApprovalMessageGenerative",
    ).mockResolvedValue("test message");
  });

  test("identity-known unknown sender does not auto-deny pending approval", async () => {
    const sessionMock = registerPendingInteraction(
      "req-unknown-no-auto-deny-1",
      CONVERSATION_ID,
      TOOL_NAME,
      TOOL_INPUT,
    );

    const result = await handleApprovalInterception({
      conversationId: CONVERSATION_ID,
      content: "approve",
      conversationExternalId: REQUESTER_CHAT,
      sourceChannel: "telegram",
      actorExternalId: "intruder-user-1",
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: {
        sourceChannel: "telegram",
        trustClass: "unknown",
        requesterExternalUserId: "intruder-user-1",
        guardianExternalUserId: "guardian-1",
      } as TrustContext,
      assistantId: ASSISTANT_ID,
    });

    expect(result.handled).toBe(true);
    expect(result.type).toBe("assistant_turn");
    expect(sessionMock).not.toHaveBeenCalled();

    deliverSpy.mockRestore();
    composeSpy.mockRestore();
  });

  test("guardian apr: callback with a principal matching the anchor applies the decision", async () => {
    _anchorPrincipalId = "guardian-principal-1";
    const sessionMock = registerPendingInteraction(
      "req-guardian-apply-1",
      CONVERSATION_ID,
      TOOL_NAME,
      TOOL_INPUT,
    );

    const result = await handleApprovalInterception({
      conversationId: CONVERSATION_ID,
      callbackData: "apr:req-guardian-apply-1:approve_once",
      content: "",
      conversationExternalId: REQUESTER_CHAT,
      sourceChannel: "telegram",
      actorExternalId: "guardian-user-1",
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: {
        sourceChannel: "telegram",
        trustClass: "guardian",
        requesterExternalUserId: "guardian-user-1",
        guardianExternalUserId: "guardian-user-1",
        guardianPrincipalId: "guardian-principal-1",
      } as TrustContext,
      assistantId: ASSISTANT_ID,
    });

    expect(result.handled).toBe(true);
    expect(result.type).toBe("decision_applied");
    expect(sessionMock).toHaveBeenCalled();
  });

  test("guardian apr: callback with a principal NOT matching the anchor is rejected before any decision", async () => {
    _anchorPrincipalId = "the-real-guardian-principal";
    const sessionMock = registerPendingInteraction(
      "req-guardian-mismatch-1",
      CONVERSATION_ID,
      TOOL_NAME,
      TOOL_INPUT,
    );

    const result = await handleApprovalInterception({
      conversationId: CONVERSATION_ID,
      callbackData: "apr:req-guardian-mismatch-1:approve_once",
      content: "",
      conversationExternalId: REQUESTER_CHAT,
      sourceChannel: "telegram",
      actorExternalId: "stale-guardian-user",
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: {
        sourceChannel: "telegram",
        trustClass: "guardian",
        requesterExternalUserId: "stale-guardian-user",
        guardianExternalUserId: "stale-guardian-user",
        guardianPrincipalId: "some-other-principal",
      } as TrustContext,
      assistantId: ASSISTANT_ID,
    });

    expect(result.handled).toBe(true);
    expect(result.type).toBe("stale_ignored");
    expect(sessionMock).not.toHaveBeenCalled();
    // Generic failure copy — no oracle about pending requests or permission.
    const replyText = (
      deliverSpy.mock.calls[0]?.[1] as { text?: string } | undefined
    )?.text;
    expect(replyText).toBe("Sorry, I couldn't process that. Please try again.");
  });

  test("guardian without a resolved acting principal is rejected before any decision", async () => {
    // Address-only guardian classification (e.g. a binding row with a null
    // principal) must not authorize decisions.
    _anchorPrincipalId = "the-real-guardian-principal";
    const sessionMock = registerPendingInteraction(
      "req-guardian-no-principal-1",
      CONVERSATION_ID,
      TOOL_NAME,
      TOOL_INPUT,
    );

    const result = await handleApprovalInterception({
      conversationId: CONVERSATION_ID,
      callbackData: "apr:req-guardian-no-principal-1:approve_once",
      content: "",
      conversationExternalId: REQUESTER_CHAT,
      sourceChannel: "telegram",
      actorExternalId: "guardian-user-1",
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: {
        sourceChannel: "telegram",
        trustClass: "guardian",
        requesterExternalUserId: "guardian-user-1",
        guardianExternalUserId: "guardian-user-1",
      } as TrustContext,
      assistantId: ASSISTANT_ID,
    });

    expect(result.handled).toBe(true);
    expect(result.type).toBe("stale_ignored");
    expect(sessionMock).not.toHaveBeenCalled();
  });

  test("guardian decision defers to the verdict when the anchor read is unresolvable", async () => {
    // Transient gateway miss on the anchor read: the gateway-stamped verdict
    // (which already classified the actor guardian by principal) wins.
    _anchorPrincipalId = undefined;
    const sessionMock = registerPendingInteraction(
      "req-guardian-anchor-miss-1",
      CONVERSATION_ID,
      TOOL_NAME,
      TOOL_INPUT,
    );

    const result = await handleApprovalInterception({
      conversationId: CONVERSATION_ID,
      callbackData: "apr:req-guardian-anchor-miss-1:approve_once",
      content: "",
      conversationExternalId: REQUESTER_CHAT,
      sourceChannel: "telegram",
      actorExternalId: "guardian-user-1",
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: {
        sourceChannel: "telegram",
        trustClass: "guardian",
        requesterExternalUserId: "guardian-user-1",
        guardianExternalUserId: "guardian-user-1",
        guardianPrincipalId: "guardian-principal-1",
      } as TrustContext,
      assistantId: ASSISTANT_ID,
    });

    expect(result.handled).toBe(true);
    expect(result.type).toBe("decision_applied");
    expect(sessionMock).toHaveBeenCalled();
  });

  test("unverified sender (no identity) auto-denies pending approval", async () => {
    const sessionMock = registerPendingInteraction(
      "req-unknown-auto-deny-1",
      CONVERSATION_ID,
      TOOL_NAME,
      TOOL_INPUT,
    );

    const result = await handleApprovalInterception({
      conversationId: CONVERSATION_ID,
      content: "approve",
      conversationExternalId: REQUESTER_CHAT,
      sourceChannel: "telegram",
      actorExternalId: undefined,
      replyCallbackUrl: "https://gateway.test/deliver",
      trustCtx: {
        sourceChannel: "telegram",
        trustClass: "unknown",
      } as TrustContext,
      assistantId: ASSISTANT_ID,
    });

    expect(result.handled).toBe(true);
    expect(result.type).toBe("decision_applied");
    expect(sessionMock).toHaveBeenCalled();
    expect(sessionMock.mock.calls[0]?.[0]).toBe("req-unknown-auto-deny-1");
    expect(sessionMock.mock.calls[0]?.[1]).toBe("deny");

    deliverSpy.mockRestore();
    composeSpy.mockRestore();
  });
});
