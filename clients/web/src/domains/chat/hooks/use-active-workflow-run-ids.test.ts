/**
 * Tests for `useActiveWorkflowRunIds` — the atomic selector that exposes the
 * currently-running workflow run ids in stable `orderedIds` (spawn) order.
 *
 * Drives the real `useWorkflowStore` (seeded via `startRun` / `completeRun`)
 * so the selector + `useShallow` reference stability are exercised exactly as
 * a consumer would observe them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useActiveWorkflowRunIds } from "@/domains/chat/hooks/use-active-workflow-run-ids";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import type { WorkflowRunStatus } from "@vellumai/assistant-api";

afterEach(() => {
  cleanup();
  useWorkflowStore.getState().reset();
});

/** Start a run (defaults to `running`) and, for terminal statuses, complete it. */
function seed(runId: string, status: WorkflowRunStatus) {
  const store = useWorkflowStore.getState();
  store.startRun({ runId, label: runId, timestamp: Date.now() });
  if (status !== "running") {
    store.completeRun({
      runId,
      status,
      agentsSpawned: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  }
}

describe("useActiveWorkflowRunIds", () => {
  test("returns only running ids in spawn order", () => {
    // GIVEN three runs started in order with mixed statuses
    act(() => {
      seed("a", "running");
      seed("b", "completed");
      seed("c", "running");
    });

    // WHEN the hook renders
    const { result } = renderHook(() => useActiveWorkflowRunIds());

    // THEN only the running ids surface, in `orderedIds` (spawn) order
    expect(result.current).toEqual(["a", "c"]);
  });

  test("excludes all terminal statuses", () => {
    act(() => {
      seed("running", "running");
      seed("completed", "completed");
      seed("failed", "failed");
      seed("aborted", "aborted");
      seed("cap_exceeded", "cap_exceeded");
      seed("interrupted", "interrupted");
    });

    const { result } = renderHook(() => useActiveWorkflowRunIds());

    expect(result.current).toEqual(["running"]);
  });

  test("keeps a stable array reference across no-op active-set updates", () => {
    // GIVEN one running and one completed run
    act(() => {
      seed("active", "running");
      seed("done", "completed");
    });

    const { result } = renderHook(() => useActiveWorkflowRunIds());
    const first = result.current;
    expect(first).toEqual(["active"]);

    // WHEN a store update lands that does NOT change the active set
    // (re-applying `completed` to the already-completed run bumps `byId`
    // but leaves the filtered ids identical)
    act(() => {
      useWorkflowStore.getState().completeRun({
        runId: "done",
        status: "completed",
        agentsSpawned: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
    });

    // THEN `useShallow` suppresses the churn — same reference, no re-render
    expect(result.current).toBe(first);
  });
});
