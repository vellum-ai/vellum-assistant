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
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { WORKFLOW_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/workflow";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import { useViewerStore } from "@/stores/viewer-store";

afterEach(() => {
  cleanup();
  useWorkflowStore.getState().reset();
  useViewerStore.getState().reset();
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
