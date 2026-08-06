import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useInteractionStore } from "@/domains/chat/interaction-store";

import { useAcpAutoContinue } from "./use-acp-auto-continue";

// The interaction store is a module singleton; fully reset it before each test
// so neither the continue flag nor a lingering Connect card / dismissed-id set
// can leak in from another test (or another file in a shared run).
beforeEach(() => {
  useInteractionStore.getState().resetAll();
});

afterEach(() => {
  cleanup();
  useInteractionStore.getState().resetAll();
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

  test("retires the connected Connect card when it fires", () => {
    // A normal send no longer dismisses the Connect card (it stays until
    // resolved), so the connect → auto-continue path must clear the lingering
    // "connected — continuing..." card itself as the task resumes.
    act(() => {
      useInteractionStore.getState().showAcpConnect({ toolUseId: "tc-1" });
    });
    const onContinue = mock(() => {});
    renderHook(() => useAcpAutoContinue(onContinue));

    act(() => {
      useInteractionStore.getState().requestAcpContinue();
    });

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });
});
