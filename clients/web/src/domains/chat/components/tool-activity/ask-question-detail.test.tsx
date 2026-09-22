/**
 * `AskQuestionDetail` prefers the structured records (the persisted answer for
 * a settled prompt, the live interaction store for an outstanding one) and
 * falls back to the recorded input when it has neither, so a call always shows
 * what it asked.
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
  input: {
    activity: "Checking which release to triage",
    questions: [
      {
        question: "Which release should I triage first?",
        description: "Both have failures waiting.",
        options: [
          { id: "latest", label: "The latest release" },
          { id: "blocked", label: "The blocked release" },
        ],
      },
    ],
  },
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
  test("shows every option it offered, with the one taken leading", () => {
    renderDetail({ answeredQuestion: ANSWERED });

    expect(
      screen.getByText("Which release should I triage first?"),
    ).toBeDefined();
    expect(screen.getByText("Both have failures waiting.")).toBeDefined();
    // The option passed over reads quietly; the one taken does not, and is
    // repeated under them as the answer.
    expect(screen.getByText("The latest release").className).toContain(
      "content-tertiary",
    );
    const chosen = screen.getAllByText("The blocked release");
    expect(chosen).toHaveLength(2);
    for (const node of chosen) {
      expect(node.className).not.toContain("content-tertiary");
    }
  });

  test("a typed answer and a skip read as the answer, with every option quiet", () => {
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

    // Nothing on offer was taken, so every option reads quietly.
    for (const label of screen.getAllByText(/^The (latest|blocked) release$/)) {
      expect(label.className).toContain("content-tertiary");
    }
    // The answers lead, the skip included: it is what was recorded.
    expect(screen.getByText("The blocked one.").className).not.toContain(
      "content-tertiary",
    );
    expect(screen.getByText("Skipped").className).not.toContain(
      "content-tertiary",
    );
  });

  test("an option id that matches nothing offered still shows as the answer", () => {
    // A truncated or hand-edited record satisfies the wire schema. The
    // transcript card shows the raw id; the drawer must not silently drop it.
    renderDetail({
      answeredQuestion: {
        ...ANSWERED,
        responses: [
          { questionId: "q1", decision: "option", optionId: "retired" },
        ],
      },
    });

    expect(screen.getByText("retired")).toBeDefined();
    for (const label of screen.getAllByText(/^The (latest|blocked) release$/)) {
      expect(label.className).toContain("content-tertiary");
    }
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

    expect(screen.getByText("The latest release").className).not.toContain(
      "content-tertiary",
    );
    expect(screen.getByTestId("tool-output-notice").textContent).toBe(
      "Running…",
    );
  });

  test("falls back to the recorded input when no record resolves", () => {
    // Three supported cases land here: a call recorded before the answered
    // record existed, one that timed out, and an outstanding prompt a reload
    // could not tie back to this call. All must still show what was asked.
    renderDetail({
      detail: { ...DETAIL, status: "error" },
      result: "Error: the question timed out after 10 minutes.",
      isError: true,
    });

    expect(
      screen.getByText("Which release should I triage first?"),
    ).toBeDefined();
    expect(screen.getByText("The latest release")).toBeDefined();
    expect(screen.getByText("The blocked release")).toBeDefined();
    expect(
      screen.getByText("Error: the question timed out after 10 minutes."),
    ).toBeDefined();
  });

  test("a restored prompt with no tool-use id still shows its question", () => {
    useInteractionStore.setState({
      pendingQuestion: { requestId: "req-1", entries: [ENTRY] },
    });
    renderDetail({ detail: { ...DETAIL, status: "running" }, isRunning: true });

    expect(
      screen.getByText("Which release should I triage first?"),
    ).toBeDefined();
    expect(screen.getByTestId("tool-output-notice").textContent).toBe(
      "Running…",
    );
  });

  test("never draws another call's outstanding prompt as this call's answer", () => {
    useInteractionStore.setState({
      pendingQuestion: {
        requestId: "req-9",
        toolUseId: "tc-ask-other",
        entries: [{ ...ENTRY, question: "A different question entirely?" }],
      },
    });
    renderDetail({ detail: { ...DETAIL, status: "running" }, isRunning: true });

    expect(screen.queryByText("A different question entirely?")).toBeNull();
    // This call's own input is what it shows instead.
    expect(
      screen.getByText("Which release should I triage first?"),
    ).toBeDefined();
  });

  test("shows a desktop help prompt as the question it asks", () => {
    renderDetail({
      detail: {
        ...DETAIL,
        status: "running",
        input: {
          desktopHelp: {
            message: "Solve the captcha in the browser window.",
            doneLabel: "Done",
            skipLabel: "Skip",
          },
        },
      },
      isRunning: true,
    });

    expect(
      screen.getByText("Solve the captcha in the browser window."),
    ).toBeDefined();
    expect(screen.getByText("Done")).toBeDefined();
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
