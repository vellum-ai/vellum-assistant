/**
 * Tests for `ActivityStepsPanel` — the two-level activity-steps side drawer.
 *
 *  - Level 1 renders the phase-grouped timeline (phase headers + step pills)
 *    from the payload snapshot when no live group resolves.
 *  - Clicking a tool step drills into the level-2 detail (technical details +
 *    output) with an "All steps" back button; back returns to the timeline.
 *  - Clicking a thinking step drills into the reasoning text.
 *  - The header shows the run summary + step count, and the close button
 *    fires `onClose`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ToolCallCardItem } from "@/domains/chat/utils/tool-call-card-utils";
import { toolCallStatusWireFields } from "@/domains/chat/utils/message-test-helpers";

// The viewer store and chat-session-store (pulled in transitively) import the
// generated daemon SDK, which isn't built in CI/worktree checkouts. Stub all
// endpoints so the module loads; the panel never invokes them.
const sdkStub = async () => ({ data: undefined });
const realSdkPath = new URL(
  "../../../generated/daemon/sdk.gen.ts",
  import.meta.url,
).pathname;
const sdkSource = await Bun.file(realSdkPath).text();
const exportNames = [...sdkSource.matchAll(/^export const (\w+)/gm)].map(
  (m) => m[1]!,
);
const sdkMock = Object.fromEntries(exportNames.map((n) => [n, sdkStub]));
mock.module("@/generated/daemon/sdk.gen", () => sdkMock);

const { ActivityStepsPanel } = await import(
  "@/domains/chat/components/activity-steps-panel"
);

afterEach(() => {
  cleanup();
});

function makeToolCall(
  overrides: Partial<ChatMessageToolCall> & {
    id: string;
    name: string;
    status?: "running" | "completed" | "error";
  },
): ChatMessageToolCall {
  const { status = "completed", ...rest } = overrides;
  return {
    input: {},
    ...toolCallStatusWireFields(status),
    ...rest,
  };
}

const BASH = makeToolCall({
  id: "tc-1",
  name: "bash",
  status: "completed",
  input: { command: "git status", activity: "Checking git status" },
  result: "On branch main",
  startedAt: 0,
  completedAt: 2_000,
});

const THINKING_TEXT =
  "I should check the repository state before doing anything else.";

const ITEMS: ToolCallCardItem[] = [
  { kind: "thinking", text: THINKING_TEXT, startedAt: 0, completedAt: 500 },
  { kind: "toolCall", toolCall: BASH },
];

function renderPanel(onClose: () => void = () => {}) {
  return render(
    <ActivityStepsPanel
      payload={{ items: ITEMS, toolCalls: [BASH] }}
      onClose={onClose}
    />,
  );
}

describe("ActivityStepsPanel — level 1 timeline", () => {
  test("renders phase headers and step pills for the snapshot items", () => {
    const { getAllByTestId, getByLabelText } = renderPanel();
    // Two phases: "Thinking" and "Working" (bash).
    const phases = getAllByTestId("phase-header");
    expect(phases.length).toBe(2);
    // The thinking step renders as a clickable pill.
    expect(getByLabelText("View thinking")).toBeTruthy();
    // The tool step renders its pill with the activity label.
    expect(
      getByLabelText("View details: Checking git status").textContent,
    ).toContain("Checking git status");
  });

  test("header shows the run summary and step count", () => {
    const { getByText } = renderPanel();
    // Timing data present → duration summary.
    expect(getByText(/Worked for/)).toBeTruthy();
    expect(getByText("2 steps")).toBeTruthy();
  });

  test("close button fires onClose", () => {
    let closed = false;
    const { getByLabelText } = renderPanel(() => {
      closed = true;
    });
    fireEvent.click(getByLabelText("Close steps"));
    expect(closed).toBe(true);
  });
});

describe("ActivityStepsPanel — level 2 drill-in", () => {
  test("clicking a tool step shows its detail with a back button", () => {
    const {
      getAllByText,
      getByLabelText,
      getByText,
      getByRole,
      queryByTestId,
      queryByText,
    } = renderPanel();
    fireEvent.click(getByLabelText("View details: Checking git status"));
    // Level 2: the tool detail body (tool name + input + output).
    expect(getByText("Bash")).toBeTruthy();
    expect(getByText("On branch main")).toBeTruthy();
    // The timeline is replaced, and the header swaps to the step's title with
    // the back chevron on its left (the run summary is gone). The activity
    // label appears twice: the header title and the detail body's subtitle.
    expect(queryByTestId("phase-header")).toBeNull();
    expect(queryByText(/Worked for/)).toBeNull();
    expect(getAllByText("Checking git status").length).toBeGreaterThan(1);
    expect(getByRole("button", { name: /back to all steps/i })).toBeTruthy();
  });

  test("the back button returns to the timeline", () => {
    const { getByLabelText, getByRole, getAllByTestId, queryByText } =
      renderPanel();
    fireEvent.click(getByLabelText("View details: Checking git status"));
    fireEvent.click(getByRole("button", { name: /back to all steps/i }));
    expect(getAllByTestId("phase-header").length).toBe(2);
    // The detail body (title-cased tool name) is gone again.
    expect(queryByText("Bash")).toBeNull();
  });

  test("clicking a thinking step shows the full reasoning text", () => {
    const { getByLabelText, getByText, getByRole } = renderPanel();
    fireEvent.click(getByLabelText("View thinking"));
    // The full (untruncated) reasoning renders in the detail level.
    expect(getByText(THINKING_TEXT)).toBeTruthy();
    expect(getByRole("button", { name: /back to all steps/i })).toBeTruthy();
  });
});
