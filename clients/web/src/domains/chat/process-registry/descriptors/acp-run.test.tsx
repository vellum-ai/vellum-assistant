/**
 * Tests for `ACP_RUN_DESCRIPTOR` — the registry projection of the ACP-run
 * surface. Asserts the static descriptor metadata and the `useCardSummary`
 * field rename, including the `warning` state a cancelled-completed run maps to
 * (parity with the inline card).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { ACP_RUN_DESCRIPTOR } from "@/domains/chat/process-registry/descriptors/acp-run";

afterEach(() => {
  cleanup();
  useAcpRunStore.getState().reset();
});

/** Spawn an active ("running") run, then optionally settle it terminal. */
function seedRun(acpSessionId: string) {
  useAcpRunStore.getState().spawnRun({
    acpSessionId,
    agent: "claude",
    parentConversationId: "conv-1",
    startedAt: 0,
  });
}

describe("ACP_RUN_DESCRIPTOR — static metadata", () => {
  test("kind discriminates as acp-run", () => {
    expect(ACP_RUN_DESCRIPTOR.kind).toBe("acp-run");
  });

  test("overlayTitle pluralizes on count", () => {
    expect(ACP_RUN_DESCRIPTOR.overlayTitle(1)).toBe("1 Active Run");
    expect(ACP_RUN_DESCRIPTOR.overlayTitle(3)).toBe("3 Active Runs");
  });

  test("pill is stacked with the agent-mark cap", () => {
    expect(ACP_RUN_DESCRIPTOR.pill.variant).toBe("stacked");
    if (ACP_RUN_DESCRIPTOR.pill.variant === "stacked") {
      expect(ACP_RUN_DESCRIPTOR.pill.max).toBe(6);
    }
  });

  test("aria copy", () => {
    expect(ACP_RUN_DESCRIPTOR.openCardAriaLabel).toBe("Open run");
    expect(ACP_RUN_DESCRIPTOR.pillAriaLabel(3)).toBe("Active runs");
  });

  test("exposes a stop action", () => {
    expect(typeof ACP_RUN_DESCRIPTOR.onStop).toBe("function");
  });
});

describe("ACP_RUN_DESCRIPTOR — useCardSummary", () => {
  test("renames the card-data fields", () => {
    act(() => {
      seedRun("run-1");
    });

    const { result } = renderHook(() =>
      ACP_RUN_DESCRIPTOR.useCardSummary("run-1"),
    );

    // A freshly-spawned (running) run is `loading` with the default title.
    expect(result.current).toEqual({
      state: "loading",
      title: "Working",
      info: "",
      count: "0 steps",
    });
  });

  test("returns null for an unknown run (spawn race)", () => {
    const { result } = renderHook(() =>
      ACP_RUN_DESCRIPTOR.useCardSummary("missing"),
    );

    expect(result.current).toBeNull();
  });

  test("a cancelled-completed run maps to the warning state", () => {
    act(() => {
      seedRun("run-1");
      // A `completed` run whose stop reason is `cancelled` reads as partial
      // work — `warning` — not `complete`.
      useAcpRunStore.getState().setTerminal({
        acpSessionId: "run-1",
        status: "completed",
        stopReason: "cancelled",
        completedAt: 1,
      });
    });

    const { result } = renderHook(() =>
      ACP_RUN_DESCRIPTOR.useCardSummary("run-1"),
    );

    expect(result.current?.state).toBe("warning");
  });
});
