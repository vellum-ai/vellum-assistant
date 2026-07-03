/**
 * Tests for `useActiveAcpRunIds` — the atomic selector exposing the currently
 * active ACP run ids for a conversation, in stable `orderedIds` order. The
 * store is global (all conversations' runs), so the selector scopes results by
 * each run's `parentConversationId`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useActiveAcpRunIds } from "@/domains/chat/hooks/use-active-acp-run-ids";
import { useAcpRunStore } from "@/domains/chat/acp-run-store";

afterEach(() => {
  cleanup();
  useAcpRunStore.getState().reset();
});

/** Spawn an active ("running") run in `parentConversationId`. */
function seedRun(acpSessionId: string, parentConversationId: string) {
  useAcpRunStore.getState().spawnRun({
    acpSessionId,
    agent: "claude",
    parentConversationId,
    startedAt: 0,
  });
}

describe("useActiveAcpRunIds", () => {
  test("returns active runs for the current conversation, excluding others", () => {
    act(() => {
      seedRun("here", "conv-1");
      seedRun("elsewhere", "conv-2");
    });

    const { result } = renderHook(() => useActiveAcpRunIds("conv-1"));

    expect(result.current).toEqual(["here"]);
  });

  test("excludes terminal runs", () => {
    act(() => {
      seedRun("running", "conv-1");
      seedRun("done", "conv-1");
      useAcpRunStore.getState().setTerminal({
        acpSessionId: "done",
        status: "completed",
        completedAt: 1,
      });
    });

    const { result } = renderHook(() => useActiveAcpRunIds("conv-1"));

    expect(result.current).toEqual(["running"]);
  });

  test("keeps a run whose parent conversation is unknown (rehydrated empty)", () => {
    act(() => {
      seedRun("unknown", "");
      seedRun("elsewhere", "conv-2");
    });

    const { result } = renderHook(() => useActiveAcpRunIds("conv-1"));

    // The unknown-conversation run stays visible; the one known to belong to
    // another conversation is filtered out.
    expect(result.current).toEqual(["unknown"]);
  });
});
