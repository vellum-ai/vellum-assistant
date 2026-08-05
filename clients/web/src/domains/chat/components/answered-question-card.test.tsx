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

import { hasRenderableAnswer } from "@/domains/chat/answered-question";
import { AnsweredQuestionCard } from "@/domains/chat/components/answered-question-card";

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

  test("renders exactly when hasRenderableAnswer says it will", () => {
    // The transcript hides the raw tool chip based on the predicate, so if the
    // predicate and the card ever disagree the step renders neither and drops
    // out of the conversation. Pin them together.
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
