/**
 * Tests for the guardian reply router's answer-mode handling
 * (`guardian-reply-router.ts`):
 *
 *  - an `apr:<requestId>:answer_<idx>` / `:answer_skip` callback on an
 *    answer-mode request applies a decision carrying the token as userText
 *    (the pending_question resolver maps it to the option);
 *  - an answer token aimed at an approval-mode request is never applied;
 *  - a bare text reply while exactly ONE answer-mode request is pending IS
 *    the answer — including replies that look like decision words ("no"),
 *    and it must be consumed (never fall through to an agent turn, which
 *    would deadlock behind the parked question's processing lock);
 *  - bare non-decision text with a sole approval-mode request stays
 *    not-consumed (existing behavior).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { GuardianRequestWire } from "../channels/gateway-guardian-requests.js";

// Capture decisions instead of running the real primitive (CAS + resolvers).
const applyGuardianDecisionMock = mock(
  (_params: Record<string, unknown>): Promise<Record<string, unknown>> =>
    Promise.resolve({ applied: true }),
);

// Gateway-request reads return fixtures configured per test.
let requestsById = new Map<string, GuardianRequestWire>();
let pendingList: GuardianRequestWire[] = [];

mock.module("../approvals/guardian-decision-primitive.js", () => ({
  applyGuardianDecision: (params: Record<string, unknown>) =>
    applyGuardianDecisionMock(params),
}));

mock.module("../channels/gateway-guardian-requests.js", () => ({
  getGuardianRequestOrNull: (id: string) =>
    Promise.resolve(requestsById.get(id) ?? null),
  getGuardianRequestByCodeOrNull: () => Promise.resolve(null),
  getPendingRequestByDestinationMessageOrNull: () => Promise.resolve(null),
  listGuardianRequestsOrEmpty: () => Promise.resolve(pendingList),
}));

const { routeGuardianReply } =
  await import("../runtime/guardian-reply-router.js");

function makeRequest(
  overrides: Partial<GuardianRequestWire> = {},
): GuardianRequestWire {
  return {
    id: "req-q1",
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

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    messageText: "",
    channel: "telegram",
    actor: {
      actorPrincipalId: "prin-guardian",
      actorExternalUserId: "tg-guardian",
      channel: "telegram",
      guardianPrincipalId: "prin-guardian",
    },
    conversationId: "conv-guardian",
    ...overrides,
  };
}

beforeEach(() => {
  applyGuardianDecisionMock.mockClear();
  applyGuardianDecisionMock.mockImplementation(() =>
    Promise.resolve({ applied: true }),
  );
  requestsById = new Map();
  pendingList = [];
});

describe("answer-option callback taps", () => {
  test("applies an option token on an answer-mode request as userText", async () => {
    const request = makeRequest();
    requestsById.set(request.id, request);

    const result = await routeGuardianReply(
      makeContext({ callbackData: "apr:req-q1:answer_1" }),
    );

    expect(result.consumed).toBe(true);
    expect(result.decisionApplied).toBe(true);
    expect(applyGuardianDecisionMock).toHaveBeenCalledTimes(1);
    expect(applyGuardianDecisionMock.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-q1",
      action: "approve_once",
      userText: "answer_1",
    });
  });

  test("applies the skip token as a reject decision carrying the token", async () => {
    const request = makeRequest();
    requestsById.set(request.id, request);

    await routeGuardianReply(
      makeContext({ callbackData: "apr:req-q1:answer_skip" }),
    );

    expect(applyGuardianDecisionMock.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-q1",
      action: "reject",
      userText: "answer_skip",
    });
  });

  test("never applies an answer token aimed at an approval-mode request", async () => {
    const request = makeRequest({
      id: "req-t1",
      kind: "tool_approval",
      toolName: "bash",
    });
    requestsById.set(request.id, request);

    const result = await routeGuardianReply(
      makeContext({ callbackData: "apr:req-t1:answer_0" }),
    );

    expect(result.consumed).toBe(false);
    expect(applyGuardianDecisionMock).not.toHaveBeenCalled();
  });
});

describe("bare-text answers to a sole pending question", () => {
  test("treats an unprefixed reply as the answer and consumes it", async () => {
    pendingList = [makeRequest()];

    const result = await routeGuardianReply(
      makeContext({ messageText: "3pm works" }),
    );

    // Consumption matters as much as the decision: an unconsumed reply would
    // fall through to a normal agent turn and defer behind the parked
    // question's processing lock until the prompt timeout.
    expect(result.consumed).toBe(true);
    expect(applyGuardianDecisionMock.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-q1",
      action: "approve_once",
      userText: "3pm works",
    });
  });

  test('a decision-looking word ("no") is the ANSWER, not a rejection', async () => {
    pendingList = [makeRequest()];

    await routeGuardianReply(makeContext({ messageText: "no" }));

    expect(applyGuardianDecisionMock.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-q1",
      action: "approve_once",
      userText: "no",
    });
  });

  test("non-decision text with a sole approval-mode request stays not consumed", async () => {
    pendingList = [
      makeRequest({ id: "req-t1", kind: "tool_approval", toolName: "bash" }),
    ];

    const result = await routeGuardianReply(
      makeContext({ messageText: "3pm works" }),
    );

    expect(result.consumed).toBe(false);
    expect(applyGuardianDecisionMock).not.toHaveBeenCalled();
  });
});
