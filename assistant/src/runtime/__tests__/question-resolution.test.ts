/**
 * Tests for the shared question resolver (`question-resolution.ts`) — the single
 * implementation `/v1/question-response` and the channel wizard both funnel
 * through. Focuses on the discriminated outcome (resolved / not_found / invalid)
 * that lets each caller map to its own surface.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { QuestionPromptResult } from "../../permissions/question-prompter.js";
import * as pendingInteractions from "../pending-interactions.js";
import { resolvePendingQuestion } from "../question-resolution.js";

function registerQuestion(
  requestId: string,
  questions: Array<{ id: string; options: string[] }>,
  rpcResolve: (value: unknown) => void = () => {},
): void {
  const optionsById: Record<string, string[]> = {};
  for (const q of questions) {
    optionsById[q.id] = q.options;
  }
  pendingInteractions.register(requestId, {
    conversationId: "conv-1",
    kind: "question",
    rpcResolve,
    metadata: { orderedIds: questions.map((q) => q.id), optionsById },
  });
}

beforeEach(() => pendingInteractions.clear());
afterEach(() => pendingInteractions.clear());

describe("resolvePendingQuestion", () => {
  test("resolved: submits, fires rpcResolve, and consumes the interaction", () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion("req-1", [{ id: "q1", options: ["a", "b"] }], (v) =>
      resolved.push(v as QuestionPromptResult),
    );

    const outcome = resolvePendingQuestion("req-1", {
      kind: "submit",
      submissions: [{ questionId: "q1", kind: "option", optionId: "a" }],
    });

    expect(outcome).toMatchObject({
      status: "resolved",
      conversationId: "conv-1",
    });
    expect(resolved[0].overall).toBe("completed");
    expect(pendingInteractions.get("req-1")).toBeUndefined();
  });

  test("close: reports every question skipped, overall closed", () => {
    const resolved: QuestionPromptResult[] = [];
    registerQuestion(
      "req-1",
      [
        { id: "q1", options: ["a"] },
        { id: "q2", options: ["b"] },
      ],
      (v) => resolved.push(v as QuestionPromptResult),
    );

    const outcome = resolvePendingQuestion("req-1", { kind: "close" });
    expect(outcome.status).toBe("resolved");
    expect(resolved[0]).toEqual({
      overall: "closed",
      entries: [
        { questionId: "q1", decision: "skipped" },
        { questionId: "q2", decision: "skipped" },
      ],
    });
  });

  test("not_found: unknown or wrong-kind requestId leaves nothing resolved", () => {
    expect(resolvePendingQuestion("missing", { kind: "close" })).toEqual({
      status: "not_found",
    });

    pendingInteractions.register("conf-1", {
      conversationId: "conv-1",
      kind: "confirmation",
    });
    expect(
      resolvePendingQuestion("conf-1", {
        kind: "submit",
        submissions: [{ questionId: "q1", kind: "skip" }],
      }),
    ).toEqual({ status: "not_found" });
  });

  test("invalid: a bad submission leaves the interaction intact for a retry", () => {
    let resolveCount = 0;
    registerQuestion(
      "req-1",
      [{ id: "q1", options: ["a", "b"] }],
      () => resolveCount++,
    );

    const outcome = resolvePendingQuestion("req-1", {
      kind: "submit",
      submissions: [{ questionId: "q1", kind: "option", optionId: "nope" }],
    });

    expect(outcome.status).toBe("invalid");
    // Interaction untouched — the prompt can be resubmitted.
    expect(pendingInteractions.get("req-1")).toBeDefined();
    expect(resolveCount).toBe(0);
  });
});
