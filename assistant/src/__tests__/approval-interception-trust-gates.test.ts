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

import type { Conversation } from "../daemon/conversation.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { initializeDb } from "../memory/db-init.js";
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
