/**
 * Tests for `computeWorkflowCardData` — the pure projection that
 * `useWorkflowCardData` wraps. Driving the pure function avoids the
 * React + Zustand context plumbing and keeps coverage focused on the
 * `WorkflowEntry → ToolCallCardData` mapping.
 */

import { describe, expect, test } from "bun:test";

import { computeWorkflowCardData } from "@/domains/chat/hooks/use-workflow-card-data";
import type {
  WorkflowEntry,
  WorkflowLeaf,
} from "@/domains/chat/workflow-store";

const NOW = 1700000000000;

function makeEntry(
  overrides: Partial<Omit<WorkflowEntry, "leaves">> & {
    leaves?: WorkflowLeaf[];
  } = {},
): WorkflowEntry {
  const { leaves, ...rest } = overrides;
  const leafMap = new Map<number, WorkflowLeaf>();
  for (const leaf of leaves ?? []) leafMap.set(leaf.seq, leaf);
  return {
    runId: "wf-1",
    status: "running",
    agentsSpawned: 0,
    inputTokens: 0,
    outputTokens: 0,
    startedAt: NOW,
    leaves: leafMap,
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// State derivation
// ---------------------------------------------------------------------------

describe("computeWorkflowCardData — state derivation", () => {
  test("running entry → loading state", () => {
    const data = computeWorkflowCardData(makeEntry({ status: "running" }));
    expect(data.state).toBe("loading");
  });

  test("completed entry → complete state", () => {
    const data = computeWorkflowCardData(makeEntry({ status: "completed" }));
    expect(data.state).toBe("complete");
  });

  test("failed entry → error state", () => {
    const data = computeWorkflowCardData(makeEntry({ status: "failed" }));
    expect(data.state).toBe("error");
  });

  test("aborted entry → error state", () => {
    const data = computeWorkflowCardData(makeEntry({ status: "aborted" }));
    expect(data.state).toBe("error");
  });

  test("cap_exceeded entry → error state", () => {
    const data = computeWorkflowCardData(makeEntry({ status: "cap_exceeded" }));
    expect(data.state).toBe("error");
  });

  test("interrupted entry → error state", () => {
    const data = computeWorkflowCardData(makeEntry({ status: "interrupted" }));
    expect(data.state).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Leaf → step mapping
// ---------------------------------------------------------------------------

describe("computeWorkflowCardData — leaf mapping", () => {
  test("leaves project into tool steps sorted ascending by seq", () => {
    const data = computeWorkflowCardData(
      makeEntry({
        leaves: [
          { seq: 2, label: "Second", status: "running" },
          { seq: 0, label: "Zeroth", status: "completed" },
          { seq: 1, label: "First", status: "failed" },
        ],
      }),
    );
    expect(data.steps).toHaveLength(3);
    expect(data.steps.map((s) => (s.kind === "tool" ? s.title : ""))).toEqual([
      "Zeroth",
      "First",
      "Second",
    ]);
  });

  test("leaf status maps to step status (running/failed/completed)", () => {
    const data = computeWorkflowCardData(
      makeEntry({
        leaves: [
          { seq: 0, label: "running leaf", status: "running" },
          { seq: 1, label: "failed leaf", status: "failed" },
          { seq: 2, label: "done leaf", status: "completed" },
        ],
      }),
    );
    const [a, b, c] = data.steps;
    if (a?.kind === "tool") expect(a.status).toBe("running");
    if (b?.kind === "tool") expect(b.status).toBe("error");
    if (c?.kind === "tool") expect(c.status).toBe("completed");
  });

  test("label falls back to Leaf <seq> and info uses promptSummary", () => {
    const data = computeWorkflowCardData(
      makeEntry({
        leaves: [
          { seq: 7, status: "running", promptSummary: "find the tiger" },
        ],
      }),
    );
    const step = data.steps[0]!;
    expect(step.kind).toBe("tool");
    if (step.kind === "tool") {
      expect(step.title).toBe("Leaf 7");
      expect(step.info).toBe("find the tiger");
    }
  });
});

// ---------------------------------------------------------------------------
// Header content
// ---------------------------------------------------------------------------

describe("computeWorkflowCardData — current step title/info", () => {
  test("phase drives the header when set", () => {
    const data = computeWorkflowCardData(
      makeEntry({
        phase: "Planning",
        summary: "breaking down the goal",
        leaves: [{ seq: 0, label: "leaf", status: "running" }],
      }),
    );
    expect(data.currentStepTitle).toBe("Planning");
    expect(data.currentStepInfo).toBe("breaking down the goal");
  });

  test("falls back to the latest leaf when no phase is set", () => {
    const data = computeWorkflowCardData(
      makeEntry({
        leaves: [
          { seq: 0, label: "First", status: "completed" },
          { seq: 1, label: "Latest", status: "running", promptSummary: "go" },
        ],
      }),
    );
    expect(data.currentStepTitle).toBe("Latest");
    expect(data.currentStepInfo).toBe("go");
  });

  test("falls back to the run label when there are no leaves or phase", () => {
    const data = computeWorkflowCardData(
      makeEntry({ label: "Research workflow" }),
    );
    expect(data.currentStepTitle).toBe("Research workflow");
  });
});

// ---------------------------------------------------------------------------
// Step count
// ---------------------------------------------------------------------------

describe("computeWorkflowCardData — step count", () => {
  test("counts live leaves as agents", () => {
    const data = computeWorkflowCardData(
      makeEntry({
        leaves: [
          { seq: 0, status: "running" },
          { seq: 1, status: "completed" },
        ],
      }),
    );
    expect(data.stepCount).toBe("2 agents");
  });

  test("singular pill for one agent", () => {
    const data = computeWorkflowCardData(
      makeEntry({ leaves: [{ seq: 0, status: "running" }] }),
    );
    expect(data.stepCount).toBe("1 agent");
  });

  test("falls back to agentsSpawned when no leaves are tracked", () => {
    const data = computeWorkflowCardData(makeEntry({ agentsSpawned: 4 }));
    expect(data.stepCount).toBe("4 agents");
  });
});
