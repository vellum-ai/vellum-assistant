/**
 * Tests for {@link WORKFLOW_DESCRIPTOR} — the count-variant background-process
 * descriptor.
 *
 * The `useCardSummary` projection is exercised against the real
 * `useWorkflowStore` (seeded via `startRun` / `applyProgress`) so the
 * `WorkflowEntry → CardSummary` mapping is observed exactly as a consumer
 * would. The remaining assertions pin the static descriptor metadata that the
 * shared overlay/pill chrome depends on.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, renderHook } from "@testing-library/react";

// `WorkflowAgentsChip` (the descriptor's `renderCount` slot) renders
// `SubagentAvatarChip`, which lazily loads a ~48 kB bundled-avatar payload.
// Stub it to a testid so the `renderCount` test stays focused on the chip's
// count text + avatar-per-seed structure.
mock.module("@/components/avatar/subagent-avatar-chip", () => ({
  SubagentAvatarChip: ({ subagentId }: { subagentId: string }) => (
    <span data-testid="avatar-stub" data-subagent-id={subagentId} />
  ),
}));

import { WORKFLOW_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/workflow";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { useViewerStore } from "@/stores/viewer-store";

afterEach(() => {
  cleanup();
  useWorkflowStore.getState().reset();
  useViewerStore.getState().reset();
});

afterAll(() => {
  mock.restore();
});

describe("WORKFLOW_DESCRIPTOR — useCardSummary projection", () => {
  test("projects a running run into the shared CardSummary shape", () => {
    // GIVEN a running workflow with a label, live phase, and spawned agents
    act(() => {
      const store = useWorkflowStore.getState();
      store.startRun({ runId: "wf-1", label: "Research", timestamp: 1 });
      store.applyProgress({
        runId: "wf-1",
        agentsSpawned: 3,
        phase: "Synthesizing",
      });
    });

    // WHEN the descriptor's card-summary hook renders
    const { result } = renderHook(() =>
      WORKFLOW_DESCRIPTOR.useCardSummary("wf-1"),
    );

    // THEN the projected summary mirrors the workflow card data
    expect(result.current).toEqual({
      state: "loading",
      title: "Research",
      info: "Synthesizing",
      // `stepCount` is a pre-formatted noun string, passed through to `count`.
      count: "3 agents",
    });
  });

  test("singularizes the count noun for a single spawned agent", () => {
    act(() => {
      const store = useWorkflowStore.getState();
      store.startRun({ runId: "wf-solo", label: "Solo", timestamp: 1 });
      store.applyProgress({ runId: "wf-solo", agentsSpawned: 1 });
    });

    const { result } = renderHook(() =>
      WORKFLOW_DESCRIPTOR.useCardSummary("wf-solo"),
    );

    expect(result.current?.count).toBe("1 agent");
  });

  test("returns null for an unknown run id", () => {
    const { result } = renderHook(() =>
      WORKFLOW_DESCRIPTOR.useCardSummary("missing"),
    );

    expect(result.current).toBeNull();
  });
});

describe("WORKFLOW_DESCRIPTOR — static metadata", () => {
  test("identifies as the workflow kind", () => {
    expect(WORKFLOW_DESCRIPTOR.kind).toBe("workflow");
  });

  test("is the count-variant pill (single glyph, not stacked chips)", () => {
    expect(WORKFLOW_DESCRIPTOR.pill.variant).toBe("count");
  });

  test("pluralizes the overlay title by count", () => {
    expect(WORKFLOW_DESCRIPTOR.overlayTitle(1)).toBe("1 Active Workflow");
    expect(WORKFLOW_DESCRIPTOR.overlayTitle(3)).toBe("3 Active Workflows");
  });

  test("pluralizes the pill aria label by count", () => {
    expect(WORKFLOW_DESCRIPTOR.pillAriaLabel(1)).toBe("1 active workflow");
    expect(WORKFLOW_DESCRIPTOR.pillAriaLabel(3)).toBe("3 active workflows");
  });

  test("exposes a stop action", () => {
    expect(WORKFLOW_DESCRIPTOR.onStop).toBeDefined();
  });

  test("provides a renderCount slot (the agent-avatar chip)", () => {
    expect(WORKFLOW_DESCRIPTOR.renderCount).toBeDefined();

    act(() => {
      const store = useWorkflowStore.getState();
      store.startRun({ runId: "wf-chip", label: "Chip", timestamp: 1 });
      store.applyProgress({ runId: "wf-chip", agentsSpawned: 3 });
    });

    const { getByTestId } = render(
      <>{WORKFLOW_DESCRIPTOR.renderCount!("wf-chip")}</>,
    );

    // The custom count slot renders the agent-avatar chip with the formatted
    // "N agents" label rather than the default string-count Typography.
    expect(getByTestId("workflow-inline-card-agents-chip")).toBeTruthy();
    expect(
      getByTestId("workflow-inline-card-step-count").textContent,
    ).toBe("3 agents");
  });

  test("hides the renderCount chip for a 0-agent workflow", () => {
    // A run with no spawned agents projects "0 agents"; the chip self-hides so
    // a count-of-zero workflow doesn't render the avatar-stack pill.
    act(() => {
      const store = useWorkflowStore.getState();
      store.startRun({ runId: "wf-zero", label: "Zero", timestamp: 1 });
      store.applyProgress({ runId: "wf-zero", agentsSpawned: 0 });
    });

    const { queryByTestId } = render(
      <>{WORKFLOW_DESCRIPTOR.renderCount!("wf-zero")}</>,
    );

    expect(queryByTestId("workflow-inline-card-agents-chip")).toBeNull();
  });

  test("hides the renderCount chip for a 1-agent workflow", () => {
    // A single-agent run projects "1 agent"; the chip self-hides so a solo
    // workflow doesn't render the (pointless) avatar-stack pill.
    act(() => {
      const store = useWorkflowStore.getState();
      store.startRun({ runId: "wf-one", label: "One", timestamp: 1 });
      store.applyProgress({ runId: "wf-one", agentsSpawned: 1 });
    });

    const { queryByTestId } = render(
      <>{WORKFLOW_DESCRIPTOR.renderCount!("wf-one")}</>,
    );

    expect(queryByTestId("workflow-inline-card-agents-chip")).toBeNull();
  });
});

describe("WORKFLOW_DESCRIPTOR — onOpenDetail", () => {
  test("opens the workflow detail panel through the openProcessDetail facade", () => {
    // The descriptor routes through `openProcessDetail({ kind, id })`, which
    // delegates to `openWorkflowDetail` — assert the resulting viewer state.
    WORKFLOW_DESCRIPTOR.onOpenDetail("wf-1");

    const state = useViewerStore.getState();
    expect(state.mainView).toBe("workflow-detail");
    expect(state.activeWorkflowRunId).toBe("wf-1");
  });
});
