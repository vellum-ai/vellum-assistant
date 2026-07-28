/**
 * Tests for the question → guardian.question bridge
 * (`question-request-guardian-bridge.ts`): the emitted signal must be
 * deliverable (NOT source-active suppressed) and carry the option payload the
 * broadcaster renders; identity guards skip emission rather than misroute.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { GuardianRequestWire } from "../../channels/gateway-guardian-requests.js";

const emitSignalMock = mock(
  (_params: Record<string, unknown>): Promise<Record<string, unknown>> =>
    Promise.resolve({ signalId: "sig-1", deliveryResults: [] }),
);
const recordCardDeliveryMock = mock((_params: Record<string, unknown>) =>
  Promise.resolve(undefined),
);
const recordDeliveriesMock = mock((_params: Record<string, unknown>) =>
  Promise.resolve(),
);

let binding: { guardianExternalUserId: string } | null = null;

mock.module("../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: (params: Record<string, unknown>) =>
    emitSignalMock(params),
}));
mock.module("../../notifications/guardian-delivery-recorder.js", () => ({
  recordApprovalCardDelivery: (params: Record<string, unknown>) =>
    recordCardDeliveryMock(params),
  recordGuardianRequestDeliveries: (params: Record<string, unknown>) =>
    recordDeliveriesMock(params),
}));
mock.module("../channel-verification-service.js", () => ({
  getGuardianBinding: () => Promise.resolve(binding),
}));
// The vellum-card pin mirrors the target conversation's source; no DB here,
// so resolve "conversation not found" and let the helper fall back to "user".
mock.module("../../persistence/conversation-crud.js", () => ({
  getConversation: () => null,
}));

const { bridgeQuestionRequestToGuardian } =
  await import("../question-request-guardian-bridge.js");

function makeRequest(
  overrides: Partial<GuardianRequestWire> = {},
): GuardianRequestWire {
  return {
    id: "req-1",
    kind: "pending_question",
    sourceType: "channel",
    sourceChannel: "telegram",
    sourceConversationId: "conv-1",
    requesterExternalUserId: "tg-guardian",
    requesterChatId: "chat-1",
    guardianExternalUserId: "tg-guardian",
    guardianPrincipalId: "prin-guardian",
    callSessionId: null,
    pendingQuestionId: null,
    questionText: "Which fruit?",
    requestCode: "ABC123",
    toolName: null,
    inputDigest: null,
    commandPreview: null,
    riskLevel: null,
    activityText: null,
    executionTarget: null,
    requesterSignals: null,
    requestTrigger: null,
    status: "pending",
    answerText: null,
    decidedByExternalUserId: null,
    decidedByPrincipalId: null,
    followupState: null,
    expiresAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const trustContext = {
  trustClass: "guardian",
  sourceChannel: "telegram",
  guardianPrincipalId: "prin-guardian",
  guardianExternalUserId: "tg-guardian",
  requesterExternalUserId: "tg-guardian",
  requesterChatId: "chat-1",
} as never;

const question = {
  id: "q1",
  question: "Which fruit?",
  options: [
    { id: "apple", label: "Apple" },
    { id: "banana", label: "Banana" },
  ],
};

beforeEach(() => {
  emitSignalMock.mockClear();
  recordCardDeliveryMock.mockClear();
  recordDeliveriesMock.mockClear();
  binding = { guardianExternalUserId: "tg-guardian" };
});

describe("bridgeQuestionRequestToGuardian", () => {
  test("emits a DELIVERABLE guardian.question signal carrying the options", async () => {
    const result = await bridgeQuestionRequestToGuardian({
      guardianRequest: makeRequest(),
      trustContext,
      conversationId: "conv-1",
      question,
    });

    expect(result).toMatchObject({ bridged: true });
    expect(emitSignalMock).toHaveBeenCalledTimes(1);
    const signal = emitSignalMock.mock.calls[0]?.[0] as {
      attentionHints: Record<string, unknown>;
      contextPayload: Record<string, unknown>;
      conversationAffinityHint?: Record<string, string>;
    };
    // The in-app card is pinned to the conversation the question was asked
    // in — never left to LLM conversation routing.
    expect(signal.conversationAffinityHint).toEqual({ vellum: "conv-1" });
    // REGRESSION PIN: visibleInSourceNow is a hard suppression pre-gate in
    // emitNotificationSignal. The question card is the channel's ONLY way to
    // display the parked prompt — a true here silently suppresses every
    // question card and the tool hangs until the prompt timeout.
    expect(signal.attentionHints.visibleInSourceNow).toBe(false);
    expect(signal.contextPayload).toMatchObject({
      requestKind: "pending_question",
      requestId: "req-1",
      questionText: "Which fruit?",
      options: [
        { id: "apple", label: "Apple" },
        { id: "banana", label: "Banana" },
      ],
    });
  });

  test("skips emission when no guardian binding exists for the channel", async () => {
    binding = null;
    const result = await bridgeQuestionRequestToGuardian({
      guardianRequest: makeRequest(),
      trustContext,
      conversationId: "conv-1",
      question,
    });
    expect(result).toMatchObject({
      skipped: true,
      reason: "no_guardian_binding",
    });
    expect(emitSignalMock).not.toHaveBeenCalled();
  });

  test("skips emission when the binding identity no longer matches (rebind guard)", async () => {
    binding = { guardianExternalUserId: "tg-someone-else" };
    const result = await bridgeQuestionRequestToGuardian({
      guardianRequest: makeRequest(),
      trustContext,
      conversationId: "conv-1",
      question,
    });
    expect(result).toMatchObject({
      skipped: true,
      reason: "binding_identity_mismatch",
    });
    expect(emitSignalMock).not.toHaveBeenCalled();
  });
});
