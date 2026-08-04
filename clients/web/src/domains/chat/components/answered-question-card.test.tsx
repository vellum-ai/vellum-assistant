/**
 * Tests for `AnsweredQuestionCard`, the durable transcript record of an
 * `ask_question` prompt the user answered.
 *
 * The interactive prompt disappears once it resolves, so this card is the only
 * thing that keeps the user's decision readable after a conversation switch,
 * reload, or history reopen. It renders purely from the `answeredQuestion`
 * record on the tool call, which is identical on the live and rehydrated paths.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import type { AnsweredQuestion } from "@vellumai/assistant-api";

import {
  AnsweredQuestionCard,
  hasRenderableAnswer,
  resolveAnswers,
} from "@/domains/chat/components/answered-question-card";

afterEach(cleanup);

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

describe("AnsweredQuestionCard", () => {
  test("renders the question and the chosen option's label", () => {
    render(<AnsweredQuestionCard answered={makeAnswered({})} />);

    expect(screen.getByText("Which Alice?")).toBeDefined();
    expect(screen.getByText("Two contacts match.")).toBeDefined();
    expect(screen.getByText("Alice (work)")).toBeDefined();
    expect(screen.getByText("Acme Corp")).toBeDefined();
  });

  test("renders a free-text answer verbatim", () => {
    render(
      <AnsweredQuestionCard
        answered={makeAnswered({
          responses: [
            {
              questionId: "q1",
              decision: "free_text",
              text: "The one at Acme",
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("The one at Acme")).toBeDefined();
  });

  test("renders a skipped question as skipped", () => {
    render(
      <AnsweredQuestionCard
        answered={makeAnswered({
          responses: [{ questionId: "q1", decision: "skipped" }],
          overall: "closed",
        })}
      />,
    );

    expect(screen.getByText("Skipped")).toBeDefined();
  });

  test("renders one row per question in a batch, in the order asked", () => {
    render(
      <AnsweredQuestionCard
        answered={makeAnswered({
          questions: [
            ALICE_QUESTION,
            {
              id: "q2",
              question: "Which day?",
              options: [{ id: "mon", label: "Monday" }],
            },
          ],
          responses: [
            {
              questionId: "q1",
              decision: "option",
              optionId: "alice_personal",
            },
            { questionId: "q2", decision: "option", optionId: "mon" },
          ],
        })}
      />,
    );

    expect(screen.getByText("Alice (personal)")).toBeDefined();
    expect(screen.getByText("Monday")).toBeDefined();
  });

  test("renders nothing when the record carries no questions", () => {
    const { container } = render(
      <AnsweredQuestionCard
        answered={makeAnswered({ questions: [], responses: [] })}
      />,
    );

    expect(container.textContent).toBe("");
  });
});

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

  test("agrees with what the card actually renders", () => {
    for (const answered of [
      makeAnswered({}),
      makeAnswered({ questions: [], responses: [] }),
    ]) {
      const { container } = render(
        <AnsweredQuestionCard answered={answered} />,
      );
      expect(container.textContent !== "").toBe(hasRenderableAnswer(answered));
      cleanup();
    }
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
    // The single-question wire shape has no `skip` kind, so a skip arrives as
    // `free_text` with empty text. Rendering it as free text would show an
    // empty answer row, and the raw tool chip is suppressed, so the user would
    // see the question with no answer at all.
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
