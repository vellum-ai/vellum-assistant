import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { HotkeyEvent } from "@/runtime/hotkey";

let holdSupported = true;
let emitHotkeyEvent: ((event: HotkeyEvent) => void) | null = null;
const unsubscribe = mock(() => {
  emitHotkeyEvent = null;
});

mock.module(
  "@/runtime/hotkey",
  (): Partial<typeof import("@/runtime/hotkey")> => ({
    supportsModifierHold: () => holdSupported,
    subscribeToHotkeyEvents: (callback) => {
      emitHotkeyEvent = callback;
      return unsubscribe;
    },
  }),
);

const advanceCompanionIntro = mock((_action: string) => {});
mock.module(
  "@/runtime/companion-surface",
  (): Partial<typeof import("@/runtime/companion-surface")> => ({
    advanceCompanionIntro,
  }),
);

const { useCompanionIntroHoldProof } =
  await import("@/hooks/use-companion-intro-hold-proof");

const emit = (event: HotkeyEvent) => {
  act(() => {
    emitHotkeyEvent?.(event);
  });
};

describe("reporting the voice key to the companion's introduction", () => {
  beforeEach(() => {
    holdSupported = true;
    advanceCompanionIntro.mockClear();
    unsubscribe.mockClear();
  });

  afterEach(() => {
    cleanup();
    emitHotkeyEvent = null;
  });

  test("a down edge of the key is a proven hold", () => {
    renderHook(() => useCompanionIntroHoldProof());

    emit({ kind: "modifierHold", state: "down" });

    expect(advanceCompanionIntro).toHaveBeenCalledTimes(1);
    expect(advanceCompanionIntro).toHaveBeenCalledWith("holdProven");
  });

  // The window cannot see the run, so it reports every edge and main keeps
  // the ones a beat is waiting for. What it must not do is report edges that
  // are not the key arriving: a release proves nothing a press did not, and a
  // chord is a different binding.
  test("only the down edge of a hold is reported", () => {
    renderHook(() => useCompanionIntroHoldProof());

    emit({ kind: "modifierHold", state: "up", reason: "released" });
    emit({ kind: "chord", state: "down", key: "s" });
    emit({ kind: "voiceModeChord", state: "down" });

    expect(advanceCompanionIntro).not.toHaveBeenCalled();
  });

  test("listens to nothing on a host with no voice key", () => {
    holdSupported = false;
    renderHook(() => useCompanionIntroHoldProof());

    expect(emitHotkeyEvent).toBeNull();
  });

  test("lets go of the stream on unmount", () => {
    const view = renderHook(() => useCompanionIntroHoldProof());
    expect(emitHotkeyEvent).not.toBeNull();

    view.unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
