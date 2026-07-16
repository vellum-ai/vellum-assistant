import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useInteractionStore } from "@/domains/chat/interaction-store";

import { useAcpAutoContinue } from "./use-acp-auto-continue";

// The interaction store is a module singleton; reset the flag before each test
// so state can't leak in from another test (or another file in a shared run).
beforeEach(() => {
  useInteractionStore.getState().clearAcpContinue();
});

afterEach(() => {
  cleanup();
  useInteractionStore.getState().clearAcpContinue();
});

describe("useAcpAutoContinue", () => {
  test("fires onContinue once when pendingAcpContinue flips true, then clears the flag", () => {
    const onContinue = mock(() => {});
    renderHook(() => useAcpAutoContinue(onContinue));

    // Idle: nothing fires.
    expect(onContinue).toHaveBeenCalledTimes(0);

    // The card signals it finished connecting.
    act(() => {
      useInteractionStore.getState().requestAcpContinue();
    });

    // The continuation fired exactly once and the flag was cleared.
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(useInteractionStore.getState().pendingAcpContinue).toBe(false);

    // A later re-render must not re-fire it.
    act(() => {
      useInteractionStore.getState().clearAcpContinue();
    });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  test("does nothing while pendingAcpContinue is false", () => {
    const onContinue = mock(() => {});
    renderHook(() => useAcpAutoContinue(onContinue));
    expect(onContinue).toHaveBeenCalledTimes(0);
  });
});
