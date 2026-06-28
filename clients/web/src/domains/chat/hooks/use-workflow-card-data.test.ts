/**
 * Tests for `computeWorkflowCardData` — the pure projection that
 * `useWorkflowCardData` wraps. Driving the pure function avoids the
 * React + Zustand context plumbing and keeps coverage focused on the
 * `WorkflowEntry → ToolCallCardData` mapping.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  computeWorkflowCardData,
  selectWorkflowAgentAvatarSeeds,
  useWorkflowAgentAvatarSeeds,
  useWorkflowCardData,
} from "@/domains/chat/hooks/use-workflow-card-data";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
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

  test("cancelled leaf maps to a non-running, non-error step status", () => {
    const data = computeWorkflowCardData(
      makeEntry({
        leaves: [{ seq: 0, label: "cancelled leaf", status: "cancelled" }],
      }),
    );
    const step = data.steps[0]!;
    expect(step.kind).toBe("tool");
    if (step.kind === "tool") {
      expect(step.status).not.toBe("running");
      expect(step.status).not.toBe("error");
      expect(step.status).toBe("completed");
    }
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
  test("title is always the workflow name; phase rides the secondary line", () => {
    const data = computeWorkflowCardData(
      makeEntry({
        label: "Research workflow",
        phase: "Planning",
        summary: "breaking down the goal",
        leaves: [{ seq: 0, label: "leaf", status: "running" }],
      }),
    );
    expect(data.currentStepTitle).toBe("Research workflow");
    expect(data.currentStepInfo).toBe("Planning");
  });

  test("the latest leaf's prompt rides the secondary line when no phase is set", () => {
    const data = computeWorkflowCardData(
      makeEntry({
        label: "Research workflow",
        leaves: [
          { seq: 0, label: "First", status: "completed" },
          { seq: 1, label: "Latest", status: "running", promptSummary: "go" },
        ],
      }),
    );
    expect(data.currentStepTitle).toBe("Research workflow");
    expect(data.currentStepInfo).toBe("go");
  });

  test("a latest leaf with no prompt falls back to its label on the secondary line", () => {
    const data = computeWorkflowCardData(
      makeEntry({
        label: "Research workflow",
        leaves: [{ seq: 1, label: "Latest", status: "running" }],
      }),
    );
    expect(data.currentStepTitle).toBe("Research workflow");
    expect(data.currentStepInfo).toBe("Latest");
  });

  test("an unlabeled latest leaf no longer leaks 'Leaf <seq>' into the title", () => {
    // Regression: the synthesis leaf carries no label, so the header used to
    // fall back to `Leaf <seq>` ("Leaf 6") instead of the workflow's name.
    const data = computeWorkflowCardData(
      makeEntry({
        label: "nba-all-teams",
        leaves: [
          { seq: 6, status: "running", promptSummary: "Compile the report" },
        ],
      }),
    );
    expect(data.currentStepTitle).toBe("nba-all-teams");
    expect(data.currentStepInfo).toBe("Compile the report");
  });

  test("uses the run label as the title with no leaves or phase", () => {
    const data = computeWorkflowCardData(
      makeEntry({ label: "Research workflow" }),
    );
    expect(data.currentStepTitle).toBe("Research workflow");
  });

  test("falls back to 'Workflow' when the run has no label", () => {
    const data = computeWorkflowCardData(makeEntry({ label: undefined }));
    expect(data.currentStepTitle).toBe("Workflow");
  });

  test("surfaces the log message as the secondary line with no phase or leaves", () => {
    const data = computeWorkflowCardData(
      makeEntry({ label: "Research workflow", message: "reading sources" }),
    );
    expect(data.currentStepTitle).toBe("Research workflow");
    expect(data.currentStepInfo).toBe("reading sources");
  });

  test("a terminal run prefers the final summary over a stale phase", () => {
    // completeRun() leaves the last live phase set, so a finished card must
    // surface the outcome (summary) instead of "Synthesizing…".
    const data = computeWorkflowCardData(
      makeEntry({
        status: "completed",
        label: "Research workflow",
        phase: "Synthesizing",
        summary: "Compiled all six divisions",
        leaves: [
          { seq: 0, label: "leaf", status: "completed", promptSummary: "go" },
        ],
      }),
    );
    expect(data.currentStepTitle).toBe("Research workflow");
    expect(data.currentStepInfo).toBe("Compiled all six divisions");
  });

  test("a terminal run with no summary falls back to the log message, not the phase", () => {
    const data = computeWorkflowCardData(
      makeEntry({
        status: "failed",
        label: "Research workflow",
        phase: "Synthesizing",
        message: "hit an error",
      }),
    );
    expect(data.currentStepInfo).toBe("hit an error");
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

// ---------------------------------------------------------------------------
// useWorkflowCardData — on-demand hydration wiring
// ---------------------------------------------------------------------------
//
// The store action itself (fetch row + journal, dedup, 404 handling) is
// covered in workflow-store.test.ts. Here we only assert the hook wires the
// effect: when the store has no entry and an assistant is active, it asks
// the store to hydrate; otherwise it stays put.
//
// The real stores are driven via `setState` (with snapshot restore) rather
// than `mock.module`, which is process-global and would leak into every
// other test file in the run.

describe("useWorkflowCardData — hydration wiring", () => {
  afterEach(() => {
    cleanup();
    useWorkflowStore.getState().reset();
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    mock.restore();
  });

  test("returns null and hydrates on demand when the entry is absent", () => {
    const realHydrate = useWorkflowStore.getState().hydrateRunIfNeeded;
    const spy = mock(async (_assistantId: string, _runId: string) => {});
    useWorkflowStore.setState({ hydrateRunIfNeeded: spy });
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });

    const { result } = renderHook(() => useWorkflowCardData("wf-absent"));

    expect(result.current).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("asst-1", "wf-absent");

    useWorkflowStore.setState({ hydrateRunIfNeeded: realHydrate });
  });

  test("does not hydrate when an entry already exists", () => {
    const realHydrate = useWorkflowStore.getState().hydrateRunIfNeeded;
    const spy = mock(async (_assistantId: string, _runId: string) => {});
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
    useWorkflowStore.getState().startRun({ runId: "wf-present", timestamp: NOW });
    useWorkflowStore.setState({ hydrateRunIfNeeded: spy });

    const { result } = renderHook(() => useWorkflowCardData("wf-present"));

    expect(result.current).not.toBeNull();
    expect(spy).not.toHaveBeenCalled();

    useWorkflowStore.setState({ hydrateRunIfNeeded: realHydrate });
  });

  test("does not hydrate when no assistant is active", () => {
    const realHydrate = useWorkflowStore.getState().hydrateRunIfNeeded;
    const spy = mock(async (_assistantId: string, _runId: string) => {});
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    useWorkflowStore.setState({ hydrateRunIfNeeded: spy });

    renderHook(() => useWorkflowCardData("wf-no-asst"));

    expect(spy).not.toHaveBeenCalled();

    useWorkflowStore.setState({ hydrateRunIfNeeded: realHydrate });
  });
});

// ---------------------------------------------------------------------------
// selectWorkflowAgentAvatarSeeds — stable seed derivation
// ---------------------------------------------------------------------------

describe("selectWorkflowAgentAvatarSeeds", () => {
  test("returns [] when the run has no leaves and no spawned agents", () => {
    const seeds = selectWorkflowAgentAvatarSeeds(makeEntry({ runId: "wf" }));
    expect(seeds).toEqual([]);
  });

  test("seeds a single leaf", () => {
    const seeds = selectWorkflowAgentAvatarSeeds(
      makeEntry({ runId: "wf", leaves: [{ seq: 0, status: "running" }] }),
    );
    expect(seeds).toEqual(["wf:0"]);
  });

  test("seeds two leaves in ascending seq order", () => {
    const seeds = selectWorkflowAgentAvatarSeeds(
      makeEntry({
        runId: "wf",
        leaves: [
          { seq: 1, status: "completed" },
          { seq: 0, status: "running" },
        ],
      }),
    );
    expect(seeds).toEqual(["wf:0", "wf:1"]);
  });

  test("caps at three seeds when more than three leaves exist", () => {
    const seeds = selectWorkflowAgentAvatarSeeds(
      makeEntry({
        runId: "wf",
        leaves: [
          { seq: 0, status: "running" },
          { seq: 1, status: "running" },
          { seq: 2, status: "running" },
          { seq: 3, status: "running" },
          { seq: 4, status: "running" },
        ],
      }),
    );
    expect(seeds).toEqual(["wf:0", "wf:1", "wf:2"]);
  });

  test("synthesizes index seeds when leaves are empty but agentsSpawned > 0", () => {
    const seeds = selectWorkflowAgentAvatarSeeds(
      makeEntry({ runId: "wf", agentsSpawned: 5 }),
    );
    expect(seeds).toEqual(["wf:0", "wf:1", "wf:2"]);
  });
});

// ---------------------------------------------------------------------------
// useWorkflowAgentAvatarSeeds — store wiring
// ---------------------------------------------------------------------------

describe("useWorkflowAgentAvatarSeeds", () => {
  afterEach(() => {
    cleanup();
    useWorkflowStore.getState().reset();
  });

  test("returns [] for an unknown runId", () => {
    const { result } = renderHook(() =>
      useWorkflowAgentAvatarSeeds("wf-unknown"),
    );
    expect(result.current).toEqual([]);
  });

  test("returns a referentially stable array across renders when the entry is unchanged", () => {
    useWorkflowStore.getState().startRun({ runId: "wf-stable", timestamp: NOW });
    useWorkflowStore.getState().leafStarted({ runId: "wf-stable", seq: 0 });

    const { result, rerender } = renderHook(() =>
      useWorkflowAgentAvatarSeeds("wf-stable"),
    );
    const first = result.current;
    rerender();
    // Same store entry ref → useMemo returns the same array (no churn).
    expect(result.current).toBe(first);
  });
});
