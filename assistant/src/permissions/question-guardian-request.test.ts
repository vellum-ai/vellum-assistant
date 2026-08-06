/**
 * Tests for the ask_question → guardian-request promotion gating
 * (`question-guardian-request.ts`): promotes only single-question batches
 * asked by the guardian on a card-capable channel, reconciles a prompt that
 * resolved before the row landed, and never throws.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { QuestionRequestEvent } from "../api/events/question-request.js";

const createGuardianRequestMock = mock(
  (params: Record<string, unknown>): Promise<Record<string, unknown>> =>
    Promise.resolve({ ...params, requestCode: "ABC123" }),
);
const expireGuardianRequestMock = mock((_id: string) => Promise.resolve());
const bridgeMock = mock((_params: Record<string, unknown>) =>
  Promise.resolve({ bridged: true as const, signalId: "req-1" }),
);
const withdrawCardsMock = mock((_params: Record<string, unknown>) =>
  Promise.resolve(),
);

let trustContext: Record<string, unknown> | undefined;
let pendingInteraction: { kind: string } | undefined;
let rowAfterExpire: Record<string, unknown> | null = null;

mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: (_id: string) =>
    trustContext ? { trustContext, assistantId: "self" } : undefined,
}));
mock.module("../channels/gateway-guardian-requests.js", () => ({
  createGuardianRequest: (params: Record<string, unknown>) =>
    createGuardianRequestMock(params),
  expireGuardianRequest: (id: string) => expireGuardianRequestMock(id),
  getGuardianRequestOrNull: (_id: string) => Promise.resolve(rowAfterExpire),
}));
mock.module("../approvals/guardian-card-withdrawal.js", () => ({
  withdrawGuardianRequestCards: (params: Record<string, unknown>) =>
    withdrawCardsMock(params),
}));
mock.module("../runtime/question-request-guardian-bridge.js", () => ({
  bridgeQuestionRequestToGuardian: (params: Record<string, unknown>) =>
    bridgeMock(params),
}));
mock.module("../runtime/pending-interactions.js", () => ({
  get: (_id: string) => pendingInteraction,
}));

const { createGuardianRequestForQuestion, settlePromotedQuestionRequest } =
  await import("./question-guardian-request.js");

/** Let the settle helper's fire-and-forget chain drain. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

const entry = {
  id: "q1",
  question: "Which fruit?",
  options: [
    { id: "apple", label: "Apple" },
    { id: "banana", label: "Banana" },
  ],
};

function makeEvent(
  overrides: Partial<QuestionRequestEvent> = {},
): QuestionRequestEvent {
  return {
    type: "question_request",
    requestId: "req-1",
    questions: [entry],
    question: entry.question,
    options: entry.options,
    conversationId: "conv-1",
    ...overrides,
  };
}

function guardianTrustContext(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    trustClass: "guardian",
    sourceChannel: "telegram",
    guardianPrincipalId: "prin-guardian",
    guardianExternalUserId: "tg-guardian",
    requesterExternalUserId: "tg-guardian",
    requesterChatId: "chat-1",
    ...overrides,
  };
}

beforeEach(() => {
  createGuardianRequestMock.mockClear();
  expireGuardianRequestMock.mockClear();
  bridgeMock.mockClear();
  withdrawCardsMock.mockClear();
  trustContext = guardianTrustContext();
  pendingInteraction = { kind: "question" };
  rowAfterExpire = null;
});

describe("createGuardianRequestForQuestion gating", () => {
  test("promotes a guardian's single question on a card-capable channel and bridges it", async () => {
    await createGuardianRequestForQuestion(makeEvent(), "conv-1");

    expect(createGuardianRequestMock).toHaveBeenCalledTimes(1);
    expect(createGuardianRequestMock.mock.calls[0]?.[0]).toMatchObject({
      id: "req-1",
      kind: "pending_question",
      sourceChannel: "telegram",
      sourceConversationId: "conv-1",
      guardianPrincipalId: "prin-guardian",
      questionText: "Which fruit?",
      status: "pending",
    });
    expect(bridgeMock).toHaveBeenCalledTimes(1);
    expect(bridgeMock.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "conv-1",
      question: entry,
    });
    expect(expireGuardianRequestMock).not.toHaveBeenCalled();
  });

  test("skips multi-question batches", async () => {
    await createGuardianRequestForQuestion(
      makeEvent({
        questions: [entry, { ...entry, id: "q2", question: "Which size?" }],
      }),
      "conv-1",
    );
    expect(createGuardianRequestMock).not.toHaveBeenCalled();
  });

  test("skips non-guardian turns", async () => {
    trustContext = guardianTrustContext({ trustClass: "trusted_contact" });
    await createGuardianRequestForQuestion(makeEvent(), "conv-1");
    expect(createGuardianRequestMock).not.toHaveBeenCalled();
  });

  test("skips channels without question-card delivery (whatsapp, vellum)", async () => {
    trustContext = guardianTrustContext({ sourceChannel: "whatsapp" });
    await createGuardianRequestForQuestion(makeEvent(), "conv-1");
    trustContext = guardianTrustContext({ sourceChannel: "vellum" });
    await createGuardianRequestForQuestion(makeEvent(), "conv-1");
    expect(createGuardianRequestMock).not.toHaveBeenCalled();
  });

  test("skips guardian turns with no bound principal", async () => {
    trustContext = guardianTrustContext({ guardianPrincipalId: undefined });
    await createGuardianRequestForQuestion(makeEvent(), "conv-1");
    expect(createGuardianRequestMock).not.toHaveBeenCalled();
  });

  test("expires the row instead of bridging when the prompt already resolved", async () => {
    pendingInteraction = undefined;
    await createGuardianRequestForQuestion(makeEvent(), "conv-1");

    expect(createGuardianRequestMock).toHaveBeenCalledTimes(1);
    expect(expireGuardianRequestMock).toHaveBeenCalledTimes(1);
    expect(bridgeMock).not.toHaveBeenCalled();
  });

  test("never throws when the gateway create fails", async () => {
    createGuardianRequestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("gateway down")),
    );
    await expect(
      createGuardianRequestForQuestion(makeEvent(), "conv-1"),
    ).resolves.toBeUndefined();
  });
});

describe("settlePromotedQuestionRequest", () => {
  test("expires the promoted row and withdraws its cards once", async () => {
    await createGuardianRequestForQuestion(makeEvent(), "conv-1");
    rowAfterExpire = {
      id: "req-1",
      kind: "pending_question",
      status: "expired",
    };

    settlePromotedQuestionRequest("req-1");
    await flush();

    expect(expireGuardianRequestMock).toHaveBeenCalledTimes(1);
    expect(expireGuardianRequestMock.mock.calls[0]?.[0]).toBe("req-1");
    expect(withdrawCardsMock).toHaveBeenCalledTimes(1);
    expect(withdrawCardsMock.mock.calls[0]?.[0]).toMatchObject({
      status: "expired",
    });

    // The promotion is consumed: a second settle is a no-op.
    settlePromotedQuestionRequest("req-1");
    await flush();
    expect(expireGuardianRequestMock).toHaveBeenCalledTimes(1);
  });

  test("skips withdrawal when the row was already decided by the pipeline", async () => {
    await createGuardianRequestForQuestion(makeEvent(), "conv-1");
    // The expire CAS missed — the row reads its decided status, meaning the
    // decision primitive already withdrew the cards.
    rowAfterExpire = {
      id: "req-1",
      kind: "pending_question",
      status: "approved",
    };

    settlePromotedQuestionRequest("req-1");
    await flush();

    expect(expireGuardianRequestMock).toHaveBeenCalledTimes(1);
    expect(withdrawCardsMock).not.toHaveBeenCalled();
  });

  test("is a no-op for requests that never promoted", async () => {
    settlePromotedQuestionRequest("req-never-promoted");
    await flush();
    expect(expireGuardianRequestMock).not.toHaveBeenCalled();
    expect(withdrawCardsMock).not.toHaveBeenCalled();
  });
});
