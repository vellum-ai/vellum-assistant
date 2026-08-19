/**
 * Tests for the raise/retire decision the pending-interactions registry
 * implies for the ask_question card.
 */

import { describe, expect, test } from "bun:test";

import { decidePendingQuestion } from "@/domains/chat/pending-question";
import type { PendingQuestionState } from "@/types/interaction-ui-types";
import type { QuestionEntry } from "@vellumai/assistant-api";

const ENTRIES: QuestionEntry[] = [
  {
    id: "q1",
    question: "Which draft should I send?",
    options: [
      { id: "a", label: "The short one" },
      { id: "b", label: "The long one" },
    ],
  },
];

function card(requestId: string): PendingQuestionState {
  return { requestId, entries: ENTRIES };
}

describe("decidePendingQuestion", () => {
  test("retires a card the registry no longer knows about", () => {
    // GIVEN a card on screen and a registry reporting nothing outstanding.
    // This is the reported bug: the card was answered, the chat was switched
    // away and back, and a cached history page re-raised it.
    const action = decidePendingQuestion({
      reported: null,
      current: card("req-answered"),
    });

    // THEN the stale card comes down
    expect(action).toEqual({ kind: "retire", requestId: "req-answered" });
  });

  test("raises the outstanding prompt on a cold load", () => {
    // GIVEN no card yet and a prompt genuinely awaiting an answer
    const action = decidePendingQuestion({
      reported: { requestId: "req-1", entries: ENTRIES },
      current: null,
    });

    // THEN the card is restored, which is what makes a missed
    // `question_request` (broadcast while no client was connected) recoverable
    expect(action).toEqual({
      kind: "raise",
      question: { requestId: "req-1", entries: ENTRIES },
    });
  });

  test("replaces a card whose prompt has been superseded", () => {
    // GIVEN a card for one prompt and the registry reporting a different one
    const action = decidePendingQuestion({
      reported: { requestId: "req-new", entries: ENTRIES },
      current: card("req-old"),
    });

    // THEN the newer prompt takes the slot
    expect(action).toEqual({
      kind: "raise",
      question: { requestId: "req-new", entries: ENTRIES },
    });
  });

  test("leaves an already-correct card alone", () => {
    // GIVEN the registry agreeing with what is on screen
    const action = decidePendingQuestion({
      reported: { requestId: "req-1", entries: ENTRIES },
      current: card("req-1"),
    });

    // THEN nothing moves, so a re-read cannot restart the card's own state
    // (a half-typed free-text answer, the submitting flag)
    expect(action).toEqual({ kind: "none" });
  });

  test("takes no action when the assistant carries no opinion", () => {
    // GIVEN an assistant that predates the field, reporting `undefined` rather
    // than `null`, while a card raised from the history marker is on screen
    const action = decidePendingQuestion({
      reported: undefined,
      current: card("req-1"),
    });

    // THEN the card survives. Treating "cannot answer" as "nothing pending"
    // would retire live prompts against every older assistant.
    expect(action).toEqual({ kind: "none" });
  });

  test("does not raise a prompt with no questions in it", () => {
    // GIVEN a registry entry whose batch is empty, which the card cannot render
    const action = decidePendingQuestion({
      reported: { requestId: "req-1", entries: [] },
      current: null,
    });

    // THEN nothing is raised, rather than an empty card that renders nothing
    expect(action).toEqual({ kind: "none" });
  });

  test("does not retire a rendering card over an empty batch", () => {
    // GIVEN a card on screen and a malformed report for a different prompt
    const action = decidePendingQuestion({
      reported: { requestId: "req-2", entries: [] },
      current: card("req-1"),
    });

    // THEN the working card stays: the report says the registry entry is
    // wrong, not that the user is done answering
    expect(action).toEqual({ kind: "none" });
  });
});
