/**
 * Tests for `useActiveSubagentIds` — the atomic selector that exposes the
 * currently-active (running | pending | awaiting_input) subagent ids in
 * stable `orderedIds` order.
 *
 * Drives the real `useSubagentStore` (seeded via `spawnSubagent` /
 * `changeStatus`) so the selector + `useShallow` reference stability are
 * exercised exactly as a consumer would observe them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useActiveSubagentIds } from "@/domains/chat/hooks/use-active-subagent-ids";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import type { SubagentStatus } from "@vellumai/assistant-api";

afterEach(() => {
  cleanup();
  useSubagentStore.getState().reset();
});

/** Spawn a subagent (defaults to `pending`) and move it to `status`. */
function seed(subagentId: string, status: SubagentStatus) {
  const store = useSubagentStore.getState();
  store.spawnSubagent({
    subagentId,
    label: subagentId,
    objective: "test",
    timestamp: Date.now(),
  });
  store.changeStatus({ subagentId, status });
}

describe("useActiveSubagentIds", () => {
  test("returns only running/pending ids in spawn order", () => {
    // GIVEN three subagents spawned in order with mixed statuses
    act(() => {
      seed("a", "running");
      seed("b", "completed");
      seed("c", "pending");
    });

    // WHEN the hook renders
    const { result } = renderHook(() => useActiveSubagentIds());

    // THEN only the active ids surface, in `orderedIds` (spawn) order
    expect(result.current).toEqual(["a", "c"]);
  });

  test("excludes completed, failed, and aborted subagents", () => {
    act(() => {
      seed("running", "running");
      seed("awaiting", "awaiting_input");
      seed("completed", "completed");
      seed("failed", "failed");
      seed("aborted", "aborted");
    });

    const { result } = renderHook(() => useActiveSubagentIds());

    expect(result.current).toEqual(["running", "awaiting"]);
  });

  test("keeps a stable array reference across no-op active-set updates", () => {
    // GIVEN one active and one completed subagent
    act(() => {
      seed("active", "running");
      seed("done", "completed");
    });

    const { result } = renderHook(() => useActiveSubagentIds());
    const first = result.current;
    expect(first).toEqual(["active"]);

    // WHEN a store update lands that does NOT change the active set
    // (re-applying `completed` to the already-completed subagent bumps
    // `byId` but leaves the filtered ids identical)
    act(() => {
      useSubagentStore.getState().changeStatus({
        subagentId: "done",
        status: "completed",
      });
    });

    // THEN `useShallow` suppresses the churn — same reference, no re-render
    expect(result.current).toBe(first);
  });
});
