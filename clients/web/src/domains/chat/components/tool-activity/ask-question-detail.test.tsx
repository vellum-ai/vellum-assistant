/**
 * `AskQuestionDetail` reads the structured records: the persisted answer for a
 * settled prompt, the live interaction store for an outstanding one, and
 * nothing at all when neither exists.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import type { AnsweredQuestion, QuestionEntry } from "@vellumai/assistant-api";

import { AskQuestionDetail } from "@/domains/chat/components/tool-activity/ask-question-detail";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import type { ToolDetailPayload } from "@/stores/viewer-store";

afterEach(() => {
  cleanup();
  useInteractionStore.setState({ pendingQuestion: null });
});

const DETAIL: ToolDetailPayload = {
  toolCallId: "tc-ask-1",
  toolName: "ask_question",
  title: "Asking a question",
  activity: "Checking which release to triage",
  input: { questions: [{ question: "Which release?" }] },
  status: "completed",
};

const ENTRY: QuestionEntry = {
  id: "q1",
  question: "Which release should I triage first?",
  description: "Both have failures waiting.",
  options: [
    { id: "latest", label: "The latest release", description: "Cut today." },
    { id: "blocked", label: "The blocked release" },
  ],
};

const ANSWERED: AnsweredQuestion = {
  requestId: "req-1",
  overall: "completed",
  questions: [ENTRY],
  responses: [{ questionId: "q1", decision: "option", optionId: "blocked" }],
};

function renderDetail(
  overrides: Partial<Parameters<typeof AskQuestionDetail>[0]> = {},
) {
  return render(
    <AskQuestionDetail
      detail={DETAIL}
      result={undefined}
      streamedOutput={undefined}
      activityMetadata={undefined}
      answeredQuestion={undefined}
      isRunning={false}
      isError={false}
      isDenied={false}
      {...overrides}
    />,
  );
}

describe("AskQuestionDetail", () => {
  test("shows the question as asked and what the user chose", () => {
    renderDetail({ answeredQuestion: ANSWERED });

    expect(
      screen.getByText("Which release should I triage first?"),
    ).toBeDefined();
    expect(screen.getByText("Both have failures waiting.")).toBeDefined();
    // Every option is shown, so the call can be read as asked, with the one
    // the user took marked.
    expect(screen.getByText("The latest release")).toBeDefined();
    const chosen = screen.getByText("The blocked release");
    expect(chosen.className).not.toContain("content-tertiary");
    expect(screen.getByText("The latest release").className).toContain(
      "content-tertiary",
    );
  });

  test("shows a typed answer and a skipped question for what they are", () => {
    renderDetail({
      answeredQuestion: {
        ...ANSWERED,
        questions: [ENTRY, { ...ENTRY, id: "q2", question: "And after that?" }],
        responses: [
          { questionId: "q1", decision: "free_text", text: "The blocked one." },
          { questionId: "q2", decision: "skipped" },
        ],
      },
    });

    // A typed answer matched no option, so it reads as its own row under the
    // options, and no option is marked as taken.
    expect(screen.getByText("The blocked one.")).toBeDefined();
    expect(screen.getByText("Skipped")).toBeDefined();
    expect(
      screen.getAllByText("The latest release")[0]?.className,
    ).not.toContain("content-tertiary");
  });

  test("says it is running while the prompt is outstanding", () => {
    useInteractionStore.setState({
      pendingQuestion: {
        requestId: "req-1",
        toolUseId: DETAIL.toolCallId,
        entries: [ENTRY],
      },
    });
    renderDetail({ detail: { ...DETAIL, status: "running" }, isRunning: true });

    expect(screen.getByTestId("tool-output-notice").textContent).toBe(
      "Running…",
    );
  });

  test("shows the options as offered while the prompt is outstanding", () => {
    useInteractionStore.setState({
      pendingQuestion: {
        requestId: "req-1",
        toolUseId: DETAIL.toolCallId,
        entries: [ENTRY],
      },
    });
    renderDetail({ detail: { ...DETAIL, status: "running" }, isRunning: true });

    expect(
      screen.getByText("Which release should I triage first?"),
    ).toBeDefined();
    expect(screen.getByText("The latest release")).toBeDefined();
    expect(screen.getByText("Cut today.")).toBeDefined();
    expect(screen.getByText("The blocked release")).toBeDefined();
  });

  test("never shows a prompt that belongs to another call", () => {
    // The store holds one outstanding prompt; a drawer open on an earlier
    // question must not draw the one the composer is asking now.
    useInteractionStore.setState({
      pendingQuestion: {
        requestId: "req-9",
        toolUseId: "tc-ask-other",
        entries: [ENTRY],
      },
    });
    renderDetail({ detail: { ...DETAIL, status: "running" }, isRunning: true });

    expect(
      screen.queryByText("Which release should I triage first?"),
    ).toBeNull();
    expect(screen.getByTestId("tool-output-notice").textContent).toBe(
      "Running…",
    );
  });

  test("a prompt that recorded no decision shows its result", () => {
    // A timed-out or aborted prompt: the card is gone and no record was
    // written, so the result says what happened.
    renderDetail({
      detail: { ...DETAIL, status: "error" },
      result: "Error: the question timed out after 10 minutes.",
      isError: true,
    });

    expect(
      screen.getByText("Error: the question timed out after 10 minutes."),
    ).toBeDefined();
  });

  test("a refused prompt says it was not approved, not that it failed", () => {
    renderDetail({
      detail: { ...DETAIL, status: "denied" },
      result:
        'Permission denied. The "ask_question" tool was not allowed. Do NOT retry.',
      isError: true,
      isDenied: true,
    });

    expect(
      screen.getByText("This tool call was not approved, so it did not run."),
    ).toBeDefined();
    expect(screen.queryByText(/Do NOT retry/)).toBeNull();
  });
});
