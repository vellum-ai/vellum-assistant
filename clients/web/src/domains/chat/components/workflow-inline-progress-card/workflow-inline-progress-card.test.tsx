/**
 * Tests for `WorkflowInlineProgressCard`.
 *
 * Drives the Zustand workflow store with fixture runs/leaves and asserts
 * the rendered card's presence, the agent count, the step-count→stop order,
 * the spawn-race `null` fallback, the stop affordance gating, and the
 * header-click callback.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

// `SubagentAvatarChip` (rendered inside the agents chip) lazily loads a heavy
// bundled-avatar payload, so it is stubbed to keep avatar output deterministic.
mock.module("@/components/avatar/subagent-avatar-chip", () => ({
  SubagentAvatarChip: ({ subagentId }: { subagentId: string }) => (
    <span data-testid="avatar-stub" data-subagent-id={subagentId} />
  ),
}));

import { WorkflowInlineProgressCard } from "@/domains/chat/components/workflow-inline-progress-card/workflow-inline-progress-card";
import { useWorkflowStore } from "@/domains/chat/workflow-store";

const NOW = 1700000000000;

beforeEach(() => {
  useWorkflowStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  mock.restore();
});

function startRun(runId: string, label = "Research workflow") {
  useWorkflowStore.getState().startRun({ runId, label, timestamp: NOW });
}

function addLeaf(runId: string, seq: number, label: string) {
  useWorkflowStore.getState().leafStarted({ runId, seq, label });
}

describe("WorkflowInlineProgressCard — spawn race", () => {
  test("renders null when no entry exists in the store yet", () => {
    const { container } = render(
      <WorkflowInlineProgressCard runId="missing" />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("WorkflowInlineProgressCard — fixture run", () => {
  test("renders the card and the agent count once an entry exists", () => {
    startRun("wf-1");
    addLeaf("wf-1", 0, "Agent A");
    addLeaf("wf-1", 1, "Agent B");

    const { getByText, getByTestId } = render(
      <WorkflowInlineProgressCard runId="wf-1" />,
    );

    expect(getByTestId("workflow-inline-progress-card")).toBeTruthy();
    expect(getByTestId("workflow-inline-card-agents-chip")).toBeTruthy();
    expect(getByText("2 agents")).toBeTruthy();
  });

  test("orders the step count before the stop button (matching the subagent card)", () => {
    startRun("wf-order");
    addLeaf("wf-order", 0, "Agent A");
    addLeaf("wf-order", 1, "Agent B");

    const { getByTestId } = render(
      <WorkflowInlineProgressCard runId="wf-order" onStopWorkflow={() => {}} />,
    );

    const chip = getByTestId("workflow-inline-card-agents-chip");
    const stepCount = getByTestId("workflow-inline-card-step-count");
    const stop = getByTestId("workflow-inline-card-stop");
    // The stop button follows the step count in DOM order (step count first).
    expect(
      stepCount.compareDocumentPosition(stop) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The agents chip precedes the stop button (stop stays rightmost).
    expect(
      chip.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("WorkflowInlineProgressCard — header action", () => {
  test("clicking the header row invokes onWorkflowClick", () => {
    startRun("wf-open");
    const seen: string[] = [];
    const { getByRole } = render(
      <WorkflowInlineProgressCard
        runId="wf-open"
        onWorkflowClick={(id) => seen.push(id)}
      />,
    );
    fireEvent.click(getByRole("button", { name: /open workflow/i }));
    expect(seen).toEqual(["wf-open"]);
  });
});

describe("WorkflowInlineProgressCard — stop affordance", () => {
  test("stop button only renders while the run is in-flight", () => {
    startRun("wf-stop");
    addLeaf("wf-stop", 0, "Agent A");
    const seen: string[] = [];
    const { getByTestId, queryByTestId } = render(
      <WorkflowInlineProgressCard
        runId="wf-stop"
        onStopWorkflow={(id) => seen.push(id)}
      />,
    );
    fireEvent.click(getByTestId("workflow-inline-card-stop"));
    expect(seen).toEqual(["wf-stop"]);

    act(() => {
      useWorkflowStore.getState().completeRun({
        runId: "wf-stop",
        status: "completed",
        agentsSpawned: 1,
        inputTokens: 0,
        outputTokens: 0,
      });
    });
    expect(queryByTestId("workflow-inline-card-stop")).toBeNull();
  });
});
