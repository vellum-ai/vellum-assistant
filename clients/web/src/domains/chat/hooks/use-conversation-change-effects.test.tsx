/**
 * Tests for `useConversationChangeEffects` — specifically the effect-phase
 * ordering of the store reset relative to a child card's hydration.
 *
 * A workflow/subagent card hydrates from a passive `useEffect`, capturing the
 * store's `generation` before its network await. The conversation-change reset
 * must run *before* that capture; as a passive effect it would run *after* the
 * child (effects fire children-first), so the card would capture a stale
 * generation and then discard its own hydration as invalidated — leaving the
 * card blank. Running the reset as a layout effect closes that race because
 * every layout effect in the tree fires before any passive effect.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";

import { useConversationChangeEffects } from "@/domains/chat/hooks/use-conversation-change-effects";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useWorkflowStore } from "@/domains/chat/workflow-store";

const NOW = 1700000000000;

afterEach(() => {
  cleanup();
  useWorkflowStore.getState().reset();
  useSubagentStore.getState().reset();
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
