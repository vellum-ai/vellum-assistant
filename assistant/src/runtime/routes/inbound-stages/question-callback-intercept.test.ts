/**
 * Tests for the Stage 1 question tap intercept
 * (`question-callback-intercept.ts`). Verifies a `qst:` callback is always
 * consumed (never falls through to the agent as literal text), scoped to a
 * pending question for the conversation, and records the answer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { QuestionEntry } from "../../../api/events/question-request.js";
import { _clearAllQuestionWizardState } from "../../channel-questions.js";
import * as pendingInteractions from "../../pending-interactions.js";
import { handleQuestionCallbackIntercept } from "./question-callback-intercept.js";

const CONV = "conv-1";

const entries: QuestionEntry[] = [
  {
    id: "q1",
    question: "Which fruit?",
    options: [
      { id: "a", label: "Apple" },
      { id: "b", label: "Banana" },
    ],
  },
];

function registerQuestion(
  requestId: string,
  rpcResolve: (value: unknown) => void = () => {},
): void {
  pendingInteractions.register(requestId, {
    conversationId: CONV,
    kind: "question",
    rpcResolve,
    metadata: { orderedIds: ["q1"], optionsById: { q1: ["a", "b"] } },
    questionDetails: { entries },
  });
}

beforeEach(() => {
  pendingInteractions.clear();
  _clearAllQuestionWizardState();
});
afterEach(() => {
  pendingInteractions.clear();
  _clearAllQuestionWizardState();
});

describe("handleQuestionCallbackIntercept", () => {
  test("passes through non-question callbacks (other stages handle them)", () => {
    expect(
      handleQuestionCallbackIntercept({
        conversationId: CONV,
        callbackData: "apr:req-1:approve_once",
      }),
    ).toEqual({ handled: false });
    expect(handleQuestionCallbackIntercept({ conversationId: CONV })).toEqual({
      handled: false,
    });
  });

  test("records a valid tap and reports completion", () => {
    let resolved: unknown;
    registerQuestion("req-1", (v) => (resolved = v));

    const result = handleQuestionCallbackIntercept({
      conversationId: CONV,
      callbackData: "qst:req-1:q1:0",
    });

    expect(result).toEqual({ handled: true, type: "answer_completed" });
    expect(resolved).toMatchObject({ overall: "completed" });
    expect(pendingInteractions.get("req-1")).toBeUndefined();
  });

  test("consumes a qst: tap for a non-matching conversation as stale (never reaches the agent)", () => {
    registerQuestion("req-1");
    const result = handleQuestionCallbackIntercept({
      conversationId: "other-conv",
      callbackData: "qst:req-1:q1:0",
    });
    expect(result).toEqual({ handled: true, type: "stale_ignored" });
    // The real conversation's question is untouched.
    expect(pendingInteractions.get("req-1")).toBeDefined();
  });

  test("consumes an out-of-order tap as stale", () => {
    registerQuestion("req-1");
    const result = handleQuestionCallbackIntercept({
      conversationId: CONV,
      callbackData: "qst:req-1:q2:0",
    });
    expect(result).toEqual({ handled: true, type: "stale_ignored" });
  });
});
