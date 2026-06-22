/**
 * Tests for `WorkflowInlineProgressCard`.
 *
 * Drives the Zustand workflow store with fixture runs/leaves and asserts
 * the rendered shell's presence, step-count pill, the spawn-race `null`
 * fallback, the stop affordance gating, and the header-click callback.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { WorkflowInlineProgressCard } from "@/domains/chat/components/workflow-inline-progress-card/workflow-inline-progress-card";
import { useWorkflowStore } from "@/domains/chat/workflow-store";

const NOW = 1700000000000;

beforeEach(() => {
  useWorkflowStore.getState().reset();
});

afterEach(() => {
  cleanup();
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
  test("renders the shell and the agent-count pill once an entry exists", () => {
    startRun("wf-1");
    addLeaf("wf-1", 0, "Agent A");
    addLeaf("wf-1", 1, "Agent B");

    const { getByText, getByTestId } = render(
      <WorkflowInlineProgressCard runId="wf-1" />,
    );

    expect(getByTestId("workflow-inline-card-shell")).toBeTruthy();
    expect(getByText("2 agents")).toBeTruthy();
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
