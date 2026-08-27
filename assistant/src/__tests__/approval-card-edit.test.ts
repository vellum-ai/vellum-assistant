/**
 * Approval-card editing after a button decision, across channels.
 *
 * The card edit is routed by the reply callback URL through the channel edit
 * capability, so the same interception path serves every channel whose
 * transport implements `edit`. These tests drive the Telegram shape end to
 * end at this seam: the gateway forwards the id of the message holding the
 * inline keyboard, and a decision or a stale press must edit exactly that
 * message.
 */
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const _conversationMocks = new Map<string, unknown>();
mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (id: string) => _conversationMocks.get(id),
}));

let _anchorPrincipalId: string | undefined;
mock.module("../runtime/local-actor-identity.js", () => ({
  findLocalGuardianPrincipalId: async () => _anchorPrincipalId,
}));

import type { Conversation } from "../daemon/conversation.js";
import * as providers from "../messaging/providers/index.js";
import { initializeDb } from "../persistence/db-init.js";
import * as gatewayClient from "../runtime/gateway-client.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { handleApprovalInterception } from "../runtime/routes/guardian-approval-interception.js";

await initializeDb();

const ASSISTANT_ID = "self";
const CONVERSATION_ID = "conv-card-edit-1";
const REQUESTER_CHAT = "5550100";
const TELEGRAM_CALLBACK_URL = "https://gateway.test/deliver/telegram?chat=1";
const BUTTON_MESSAGE_ID = "4242";

function registerPendingInteraction(requestId: string): void {
  const _mockSession = {
    handleConfirmationResponse: mock(() => {}),
    ensureActorScopedHistory: async () => {},
  } as unknown as Conversation;
  _conversationMocks.set(CONVERSATION_ID, _mockSession);

  pendingInteractions.register(requestId, {
    conversationId: CONVERSATION_ID,
    kind: "confirmation",
    confirmationDetails: {
      toolName: "execute_shell",
      input: { command: "ls" },
      riskLevel: "high",
      allowlistOptions: [
        { label: "test", description: "test", pattern: "test" },
      ],
      scopeOptions: [{ label: "everywhere", scope: "everywhere" }],
    },
  });
}

function guardianParams(callbackData: string) {
  return {
    conversationId: CONVERSATION_ID,
    callbackData,
    content: "",
    conversationExternalId: REQUESTER_CHAT,
    sourceChannel: "telegram" as const,
    actorExternalId: "guardian-user-1",
    replyCallbackUrl: TELEGRAM_CALLBACK_URL,
    trustCtx: {
      sourceChannel: "telegram" as const,
      trustClass: "guardian" as const,
      requesterExternalUserId: "guardian-user-1",
      guardianExternalUserId: "guardian-user-1",
      guardianPrincipalId: "guardian-principal-1",
    },
    assistantId: ASSISTANT_ID,
    approvalMessageId: BUTTON_MESSAGE_ID,
  };
}

describe("approval card edit after a button decision", () => {
  let editSpy: ReturnType<typeof spyOn>;
  let deliverSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    pendingInteractions.clear();
    _anchorPrincipalId = "guardian-principal-1";
    editSpy = spyOn(providers, "editChannelMessage").mockResolvedValue({
      ok: true,
    });
    deliverSpy = spyOn(gatewayClient, "deliverChannelReply").mockResolvedValue({
      ok: true,
    });
  });

  test("a Telegram approve button edits exactly the card message", async () => {
    registerPendingInteraction("req-card-edit-approve");

    const result = await handleApprovalInterception(
      guardianParams("apr:req-card-edit-approve:approve_once"),
    );

    expect(result).toEqual({ handled: true, type: "decision_applied" });
    expect(editSpy).toHaveBeenCalledTimes(1);
    const [callbackUrl, payload] = editSpy.mock.calls[0];
    expect(callbackUrl).toBe(TELEGRAM_CALLBACK_URL);
    expect(payload.chatId).toBe(REQUESTER_CHAT);
    expect(payload.messageId).toBe(BUTTON_MESSAGE_ID);
    expect(payload.text).toContain("Approved");

    editSpy.mockRestore();
    deliverSpy.mockRestore();
  });

  test("a Telegram reject button edits the card to Denied", async () => {
    registerPendingInteraction("req-card-edit-reject");

    const result = await handleApprovalInterception(
      guardianParams("apr:req-card-edit-reject:reject"),
    );

    expect(result).toEqual({ handled: true, type: "decision_applied" });
    expect(editSpy).toHaveBeenCalledTimes(1);
    const [, payload] = editSpy.mock.calls[0];
    expect(payload.messageId).toBe(BUTTON_MESSAGE_ID);
    expect(payload.text).toContain("Denied");

    editSpy.mockRestore();
    deliverSpy.mockRestore();
  });

  test("a stale Telegram button press marks the card resolved", async () => {
    // Pending interaction exists, but the button belongs to a different,
    // already-settled request: the card must lose its buttons rather than
    // apply to the wrong interaction.
    registerPendingInteraction("req-card-edit-live");

    const result = await handleApprovalInterception(
      guardianParams("apr:req-card-edit-settled:approve_once"),
    );

    expect(result).toEqual({ handled: true, type: "stale_ignored" });
    expect(editSpy).toHaveBeenCalledTimes(1);
    const [callbackUrl, payload] = editSpy.mock.calls[0];
    expect(callbackUrl).toBe(TELEGRAM_CALLBACK_URL);
    expect(payload.messageId).toBe(BUTTON_MESSAGE_ID);
    expect(payload.text).toBe("This approval request has been resolved.");
    expect(payload.emphasis).toBe("muted");

    editSpy.mockRestore();
    deliverSpy.mockRestore();
  });
});
