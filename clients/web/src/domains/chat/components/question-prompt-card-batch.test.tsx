/**
 * Tests for how a batched `QuestionPromptCard` routes between its questions
 * (LUM-3391).
 *
 * The card posts once, when every entry holds a draft, and it moves the user
 * along itself as each answer lands. The chevrons let someone page past a
 * question first, so "move the user along" has to mean any entry still
 * missing an answer rather than the next one in line: a skipped-past question
 * is the only thing standing between the batch and its submit, and nothing
 * else in the card goes back for it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { QuestionResponseEntry } from "@/domains/chat/api/event-types";
import { QuestionPromptCard } from "@/domains/chat/components/question-prompt-card";
import type { QuestionEntry } from "@/types/interaction-ui-types";

const ENTRIES: QuestionEntry[] = [
  {
    id: "q1",
    question: "Which channel should it watch?",
    options: [
      { id: "email", label: "Email" },
      { id: "slack", label: "Slack" },
    ],
  },
  {
    id: "q2",
    question: "How often should it report?",
    options: [
      { id: "daily", label: "Daily" },
      { id: "weekly", label: "Weekly" },
    ],
  },
];

afterEach(cleanup);

function renderBatch(onSubmitAll: (r: QuestionResponseEntry[]) => void) {
  render(
    <QuestionPromptCard
      requestId="req-1"
      entries={ENTRIES}
      isSubmitting={false}
      onSubmitAll={onSubmitAll}
    />,
  );
}

describe("QuestionPromptCard batch routing", () => {
  test("answering the last entry returns to one paged past, then submits", () => {
    const submissions: QuestionResponseEntry[][] = [];
    renderBatch((r) => submissions.push(r));

    // Page past the first question without answering it.
    fireEvent.click(screen.getByLabelText("Next question"));
    expect(screen.getByText("How often should it report?")).toBeTruthy();

    // Answering the final entry must not leave the batch stuck: the card
    // owes the user the question they skipped.
    fireEvent.click(screen.getByText("Weekly"));
    expect(submissions).toEqual([]);
    expect(screen.getByText("Which channel should it watch?")).toBeTruthy();

    fireEvent.click(screen.getByText("Slack"));

    expect(submissions).toHaveLength(1);
    // Ordered to match entries[], not the order they were answered in, so
    // the daemon can pair each response back to its question.
    expect(submissions[0]).toEqual([
      { questionId: "q1", kind: "option", optionId: "slack" },
      { questionId: "q2", kind: "option", optionId: "weekly" },
    ]);
  });

  test("answering in order still advances forward and submits once", () => {
    const submissions: QuestionResponseEntry[][] = [];
    renderBatch((r) => submissions.push(r));

    fireEvent.click(screen.getByText("Email"));
    expect(submissions).toEqual([]);
    expect(screen.getByText("How often should it report?")).toBeTruthy();

    fireEvent.click(screen.getByText("Daily"));

    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toEqual([
      { questionId: "q1", kind: "option", optionId: "email" },
      { questionId: "q2", kind: "option", optionId: "daily" },
    ]);
  });

  test("a skip counts as an answer, so it does not strand the batch either", () => {
    const submissions: QuestionResponseEntry[][] = [];
    renderBatch((r) => submissions.push(r));

    fireEvent.click(screen.getByLabelText("Next question"));
    fireEvent.click(screen.getByText("Weekly"));

    // Back on the skipped-past question; declining it explicitly is still a
    // draft, and completes the batch.
    expect(screen.getByText("Which channel should it watch?")).toBeTruthy();
    fireEvent.click(screen.getByText("Skip"));

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.[0]).toEqual({ questionId: "q1", kind: "skip" });
  });
});
