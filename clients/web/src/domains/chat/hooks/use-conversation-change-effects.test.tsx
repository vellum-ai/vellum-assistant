/**
 * Tests for `useConversationChangeEffects`:
 *
 * 1. Effect-phase ordering of the store reset relative to a child card's
 *    hydration. A workflow/subagent card hydrates from a passive `useEffect`,
 *    capturing the store's `generation` before its network await. The
 *    conversation-change reset must run *before* that capture; as a passive
 *    effect it would run *after* the child (effects fire children-first), so the
 *    card would capture a stale generation and then discard its own hydration as
 *    invalidated — leaving the card blank. Running the reset as a layout effect
 *    closes that race because every layout effect fires before any passive one.
 *
 * 2. The conversation-switch reset clears a still-running subagent. Reconcile-
 *    on-hydration (`reconcileSubagentStoreFromNotifications`) is a pure upsert
 *    that never deletes, it is one additive evidence source among SSE and the
 *    reconcile snapshot, so this reset is the *only* thing that stops a
 *    subagent in conversation A from leaking into conversation B.
 *
 * 3. The auto-fetch reaches a stub recovered from a missed `subagent_spawned`
 *    that only knows its parent conversation. Such a stub defers live events
 *    until its backfill lands, so nothing else would ever un-stick it.
 *
 * 4. The auto-fetch is bounded to rows that can't wait: live ones, and stubs
 *    deferring their events. Reconcile materializes every subagent the
 *    conversation ever ran, and a GET per settled row would turn a busy chat's
 *    load into a request burst; the detail panel fetches those on open.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";

mock.module("@/lib/backwards-compat/subagent-detail-self-lookup", () => ({
  supportsSubagentDetailSelfLookup: () => true,
}));

const fetchSubagentDetail = mock(
  async (
    _assistantId: string,
    _subagentId: string,
    _conversationId: string,
  ): Promise<null> => null,
);
mock.module("../fetch-subagent-detail", () => ({ fetchSubagentDetail }));

const { useConversationChangeEffects } = await import(
  "@/domains/chat/hooks/use-conversation-change-effects"
);
const { useSubagentStore } = await import("@/domains/chat/subagent-store");
const { useWorkflowStore } = await import("@/domains/chat/workflow-store");

const NOW = 1700000000000;

afterEach(() => {
  cleanup();
  useWorkflowStore.getState().reset();
  useSubagentStore.getState().reset();
  fetchSubagentDetail.mockClear();
});

describe("useConversationChangeEffects — reset ordering", () => {
  test("resets the workflow store before a child's passive hydration effect captures generation", async () => {
    // Seed a stale run so the conversation-change reset actually bumps
    // `generation` (reset is a no-op-on-empty otherwise it still bumps, but a
    // non-empty store makes the cleared-state assertion meaningful too).
    useWorkflowStore.getState().startRun({ runId: "stale", timestamp: NOW });
    const genBefore = useWorkflowStore.getState().generation;

    let capturedGen = -1;

    function Child() {
      // Mirrors a workflow card's passive hydration effect: it reads
      // `generation` when it begins hydrating.
      useEffect(() => {
        capturedGen = useWorkflowStore.getState().generation;
      }, []);
      return null;
    }

    function Parent() {
      useConversationChangeEffects("asst-1", "conv-1");
      return <Child />;
    }

    render(<Parent />);
    await waitFor(() => expect(capturedGen).toBeGreaterThanOrEqual(0));

    // The reset ran (layout phase) before the child's passive effect, so the
    // child observes the post-reset generation and the stale run is gone. With
    // the reset as a plain passive effect the child (deeper in the tree) would
    // run first and capture `genBefore` instead.
    expect(capturedGen).toBe(genBefore + 1);
    expect(useWorkflowStore.getState().byId["stale"]).toBeUndefined();
  });
});

describe("useConversationChangeEffects — subagent reset on conversation switch", () => {
  test("clears a still-running subagent when the conversation switches", () => {
    function Harness({ conversationId }: { conversationId: string }) {
      useConversationChangeEffects("asst-1", conversationId);
      return null;
    }

    // Mount on conversation A (the mount reset fires here, leaving an empty
    // store), then a subagent spawns mid-conversation and is still running.
    const { rerender } = render(<Harness conversationId="conv-A" />);
    useSubagentStore.getState().spawnSubagent({
      subagentId: "sa-running",
      label: "top-us-fruits",
      objective: "",
      status: "running",
      timestamp: NOW,
    });
    expect(useSubagentStore.getState().byId["sa-running"]).toBeDefined();

    // Switching the active conversation must wipe the live subagent — otherwise
    // reconcile-on-hydration would preserve it into conversation B's store.
    rerender(<Harness conversationId="conv-B" />);

    expect(useSubagentStore.getState().byId["sa-running"]).toBeUndefined();
    expect(useSubagentStore.getState().orderedIds).toEqual([]);
  });
});

describe("useConversationChangeEffects: stub detail auto-fetch", () => {
  function Harness() {
    useConversationChangeEffects("asst-1", "conv-A");
    return null;
  }

  test("hydrates a stub that only knows its parent conversation", async () => {
    render(<Harness />);

    // A `subagent_event` for an unknown id on a self-lookup daemon: the stub is
    // armed for backfill but carries no child conversation id.
    useSubagentStore.getState().ensureEntry({
      subagentId: "sa-stub",
      timestamp: NOW,
      parentConversationId: "conv-A",
    });

    await waitFor(() =>
      expect(fetchSubagentDetail).toHaveBeenCalledWith(
        "asst-1",
        "sa-stub",
        "conv-A",
      ),
    );
  });

  test("fetches a still-running row whose timeline is empty", async () => {
    render(<Harness />);

    useSubagentStore.getState().spawnSubagent({
      subagentId: "sa-live",
      label: "Agent",
      objective: "",
      status: "running",
      conversationId: "conv-child",
      timestamp: NOW,
    });

    await waitFor(() =>
      expect(fetchSubagentDetail).toHaveBeenCalledWith(
        "asst-1",
        "sa-live",
        "conv-child",
      ),
    );
  });

  test("does not fetch the settled rows reconcile materializes", async () => {
    render(<Harness />);

    // A busy chat's history: every one of these carries a child conversation
    // id and an empty timeline, and none of them is on screen.
    for (const subagentId of ["sa-1", "sa-2", "sa-3"]) {
      useSubagentStore.getState().spawnSubagent({
        subagentId,
        label: "Agent",
        objective: "",
        status: "completed",
        conversationId: `conv-child-${subagentId}`,
        timestamp: NOW,
      });
    }
    // A live sibling proves the effect ran at all rather than never firing.
    useSubagentStore.getState().spawnSubagent({
      subagentId: "sa-live",
      label: "Agent",
      objective: "",
      status: "running",
      conversationId: "conv-child-live",
      timestamp: NOW,
    });

    await waitFor(() => expect(fetchSubagentDetail).toHaveBeenCalledTimes(1));
    expect(fetchSubagentDetail).toHaveBeenCalledWith(
      "asst-1",
      "sa-live",
      "conv-child-live",
    );
  });
});
