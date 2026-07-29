/**
 * Tests for the ask_question branch of the `pending_question` guardian-request
 * resolver (`guardian-request-resolvers.ts`): a request without a
 * `callSessionId` resolves the parked in-memory `question` interaction via the
 * shared `resolvePendingQuestion` core, mapping the decision's answer-token /
 * free text / deny action onto a batch submission.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  ActorContext,
  ResolverContext,
  ResolverDecision,
} from "../approvals/guardian-request-resolvers.js";
import { getResolver } from "../approvals/guardian-request-resolvers.js";
import type { GuardianRequestWire } from "../channels/gateway-guardian-requests.js";
import type { QuestionPromptResult } from "../permissions/question-prompter.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

const resolver = getResolver("pending_question");

const actor: ActorContext = {
  actorPrincipalId: "prin-guardian",
  actorExternalUserId: "tg-guardian",
  channel: "telegram",
  guardianPrincipalId: "prin-guardian",
};

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
    status: "approved",
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

function makeContext(
  decision: ResolverDecision,
  requestOverrides: Partial<GuardianRequestWire> = {},
): ResolverContext {
  return { request: makeRequest(requestOverrides), decision, actor };
}

/** Register a parked single-question interaction like QuestionPrompter does. */
function registerQuestion(
  requestId: string,
  options: string[],
  rpcResolve: (value: unknown) => void = () => {},
): void {
  pendingInteractions.register(requestId, {
    conversationId: "conv-1",
    kind: "question",
    rpcResolve,
    metadata: { orderedIds: ["q1"], optionsById: { q1: options } },
    questionDetails: {
      entries: [
        {
          id: "q1",
          question: "Which fruit?",
          options: options.map((id) => ({ id, label: id })),
        },
      ],
    },
  });
}

beforeEach(() => pendingInteractions.clear());
afterEach(() => pendingInteractions.clear());

describe("pending_question resolver — ask_question branch", () => {
  test("an answer-option token resolves the interaction with that option", async () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion("req-q1", ["apple", "banana"], (v) =>
      resolved.push(v as QuestionPromptResult),
    );

    const result = await resolver!.resolve(
      makeContext({ action: "approve_once", userText: "answer_1" }),
    );

    expect(result).toEqual({ ok: true, applied: true });
    expect(resolved[0]?.entries).toEqual([
      { questionId: "q1", decision: "option", optionId: "banana" },
    ]);
    expect(pendingInteractions.get("req-q1")).toBeUndefined();
  });

  test("the skip token resolves the interaction as skipped", async () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion("req-q1", ["apple", "banana"], (v) =>
      resolved.push(v as QuestionPromptResult),
    );

    const result = await resolver!.resolve(
      makeContext({ action: "reject", userText: "answer_skip" }),
    );

    expect(result).toEqual({ ok: true, applied: true });
    expect(resolved[0]?.entries).toEqual([
      { questionId: "q1", decision: "skipped" },
    ]);
  });

  test("free text resolves as a free_text answer", async () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion("req-q1", ["apple", "banana"], (v) =>
      resolved.push(v as QuestionPromptResult),
    );

    const result = await resolver!.resolve(
      makeContext({ action: "approve_once", userText: "a ripe mango" }),
    );

    expect(result).toEqual({ ok: true, applied: true });
    expect(resolved[0]?.entries).toEqual([
      { questionId: "q1", decision: "free_text", text: "a ripe mango" },
    ]);
  });

  test("a deny decision with no text skips the question", async () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion("req-q1", ["apple", "banana"], (v) =>
      resolved.push(v as QuestionPromptResult),
    );

    const result = await resolver!.resolve(makeContext({ action: "reject" }));

    expect(result).toEqual({ ok: true, applied: true });
    expect(resolved[0]?.entries).toEqual([
      { questionId: "q1", decision: "skipped" },
    ]);
  });

  test("an out-of-range option index fails without consuming the interaction", async () => {
    registerQuestion("req-q1", ["apple", "banana"]);

    const result = await resolver!.resolve(
      makeContext({ action: "approve_once", userText: "answer_9" }),
    );

    expect(result).toEqual({
      ok: false,
      reason: "question_option_index_out_of_range",
    });
    expect(pendingInteractions.get("req-q1")).toBeDefined();
  });

  test("a missing interaction reports no_pending_question_interaction", async () => {
    const result = await resolver!.resolve(
      makeContext({ action: "approve_once", userText: "answer_0" }),
    );

    expect(result).toEqual({
      ok: false,
      reason: "no_pending_question_interaction",
    });
  });

  test("a multi-question interaction is refused (cards are single-question)", async () => {
    pendingInteractions.register("req-q1", {
      conversationId: "conv-1",
      kind: "question",
      rpcResolve: () => {},
      metadata: {
        orderedIds: ["q1", "q2"],
        optionsById: { q1: ["a"], q2: ["b"] },
      },
    });

    const result = await resolver!.resolve(
      makeContext({ action: "approve_once", userText: "answer_0" }),
    );

    expect(result).toEqual({ ok: false, reason: "question_batch_not_single" });
    expect(pendingInteractions.get("req-q1")).toBeDefined();
  });
});
