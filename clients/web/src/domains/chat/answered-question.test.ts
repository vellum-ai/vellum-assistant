/**
 * Tests for the pure answered-question projection: how a persisted record pairs
 * questions with responses, and whether it has anything worth rendering.
 *
 * The card's own rendering is covered in `answered-question-card.test.tsx`.
 */

import { describe, expect, test } from "bun:test";

import type { AnsweredQuestion } from "@vellumai/assistant-api";

import {
  hasRenderableAnswer,
  resolveAnswers,
} from "@/domains/chat/answered-question";

const ALICE_QUESTION = {
  id: "q1",
  question: "Which Alice?",
  description: "Two contacts match.",
  options: [
    { id: "alice_work", label: "Alice (work)", description: "Acme Corp" },
    { id: "alice_personal", label: "Alice (personal)" },
  ],
};

function makeAnswered(overrides: Partial<AnsweredQuestion>): AnsweredQuestion {
  return {
    requestId: "req-1",
    questions: [ALICE_QUESTION],
    responses: [
      { questionId: "q1", decision: "option", optionId: "alice_work" },
    ],
    overall: "completed",
    ...overrides,
  };
}

describe("hasRenderableAnswer", () => {
  // Callers hide the raw tool chip in favor of this card, so "the field is
  // set" and "the card draws something" must be the same condition. If they
  // diverge, a tool call renders neither and drops out of the transcript.
  test("is false for a record with no questions", () => {
    expect(
      hasRenderableAnswer(makeAnswered({ questions: [], responses: [] })),
    ).toBe(false);
  });

  test("is false when the field is absent", () => {
    expect(hasRenderableAnswer(undefined)).toBe(false);
  });

  test("is true for a record carrying questions", () => {
    expect(hasRenderableAnswer(makeAnswered({}))).toBe(true);
  });
});

describe("resolveAnswers", () => {
  test("pairs answers to questions by id, not by position", () => {
    const resolved = resolveAnswers(
      makeAnswered({
        questions: [
          ALICE_QUESTION,
          {
            id: "q2",
            question: "Which day?",
            options: [{ id: "mon", label: "Monday" }],
          },
        ],
        // Deliberately out of order relative to `questions`.
        responses: [
          { questionId: "q2", decision: "option", optionId: "mon" },
          { questionId: "q1", decision: "option", optionId: "alice_work" },
        ],
      }),
    );

    expect(resolved.map((r) => r.answer)).toEqual(["Alice (work)", "Monday"]);
  });

  test("reads a question with no matching response as skipped", () => {
    const resolved = resolveAnswers(makeAnswered({ responses: [] }));

    expect(resolved[0]?.kind).toBe("skipped");
    expect(resolved[0]?.answer).toBe("Skipped");
  });

  test("reads a blank free-text answer as skipped", () => {
    // The legacy single-question wire shape has no `skip` kind, so a skip
    // recorded through it reads as `free_text` with empty text, and those
    // records outlive the assistant that wrote them. Rendering it as free text
    // would show an empty answer row, and the raw tool chip is suppressed, so
    // the user would see the question with no answer at all.
    const resolved = resolveAnswers(
      makeAnswered({
        responses: [{ questionId: "q1", decision: "free_text", text: "" }],
      }),
    );

    expect(resolved[0]?.kind).toBe("skipped");
    expect(resolved[0]?.answer).toBe("Skipped");
  });

  test("reads a whitespace-only free-text answer as skipped", () => {
    const resolved = resolveAnswers(
      makeAnswered({
        responses: [{ questionId: "q1", decision: "free_text", text: "   " }],
      }),
    );

    expect(resolved[0]?.kind).toBe("skipped");
  });

  test("keeps a real free-text answer verbatim, including its spacing", () => {
    const resolved = resolveAnswers(
      makeAnswered({
        responses: [
          { questionId: "q1", decision: "free_text", text: "the one at Acme" },
        ],
      }),
    );

    expect(resolved[0]?.kind).toBe("free_text");
    expect(resolved[0]?.answer).toBe("the one at Acme");
  });

  test("falls back to the raw option id when the options no longer carry it", () => {
    const resolved = resolveAnswers(
      makeAnswered({
        responses: [
          { questionId: "q1", decision: "option", optionId: "alice_retired" },
        ],
      }),
    );

    expect(resolved[0]?.answer).toBe("alice_retired");
  });
});
