import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { HotkeyEvent } from "@/runtime/hotkey";

let holdSupported = true;
let emitHotkeyEvent: ((event: HotkeyEvent) => void) | null = null;
const setModifierHold = mock(async (_hold: unknown) => ({
  ok: true as const,
  enabled: true,
}));

mock.module("@/runtime/hotkey", () => ({
  supportsModifierHold: () => holdSupported,
  setModifierHold,
  subscribeToHotkeyEvents: (callback: (event: HotkeyEvent) => void) => {
    emitHotkeyEvent = callback;
    return () => {
      emitHotkeyEvent = null;
    };
  },
}));

const { HOLD_ARMING_MS, useHoldToDictate } = await import(
  "@/domains/chat/voice/use-hold-to-dictate"
);

const press = () => {
  act(() => {
    emitHotkeyEvent?.({ kind: "modifierHold", state: "down" });
  });
};

const release = () => {
  act(() => {
    emitHotkeyEvent?.({ kind: "modifierHold", state: "up" });
  });
};

const settle = async (ms: number) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

const renderHold = () => {
  const onHoldStart = mock(() => {});
  const onHoldEnd = mock(() => {});
  const view = renderHook(() =>
    useHoldToDictate({ onHoldStart, onHoldEnd }),
  );
  return { onHoldStart, onHoldEnd, view };
};

describe("hold to dictate", () => {
  beforeEach(() => {
    holdSupported = true;
    setModifierHold.mockClear();
  });

  afterEach(() => {
    cleanup();
    emitHotkeyEvent = null;
  });

  test("opens the microphone once the hold outlasts the arming delay", async () => {
    const { onHoldStart } = renderHold();

    press();
    expect(onHoldStart).not.toHaveBeenCalled();

    await settle(HOLD_ARMING_MS + 30);
    expect(onHoldStart).toHaveBeenCalledTimes(1);
  });

  /**
   * Every chord on these modifiers passes through the held state on its way to
   * its own key, so a release inside the delay is someone typing Ctrl+Option+F
   * rather than reaching for dictation.
   */
  test("never opens it for a hold that ends inside the delay", async () => {
    const { onHoldStart, onHoldEnd } = renderHold();

    press();
    await settle(HOLD_ARMING_MS / 3);
    release();
    await settle(HOLD_ARMING_MS + 30);

    expect(onHoldStart).not.toHaveBeenCalled();
    // And nothing is closed that was never opened.
    expect(onHoldEnd).not.toHaveBeenCalled();
  });

  test("closes it on release", async () => {
    const { onHoldStart, onHoldEnd } = renderHold();

    press();
    await settle(HOLD_ARMING_MS + 30);
    release();

    expect(onHoldStart).toHaveBeenCalledTimes(1);
    expect(onHoldEnd).toHaveBeenCalledTimes(1);
  });

  /**
   * The span is a live microphone, so unmounting mid-hold has to close it.
   * Nothing else is going to: the subscription is gone with the effect.
   */
  test("closes an open hold when the binding goes away", async () => {
    const { onHoldEnd, view } = renderHold();

    press();
    await settle(HOLD_ARMING_MS + 30);
    act(() => {
      view.unmount();
    });

    expect(onHoldEnd).toHaveBeenCalledTimes(1);
  });

  test("leaves a never-armed hold alone when the binding goes away", async () => {
    const { onHoldEnd, view } = renderHold();

    press();
    act(() => {
      view.unmount();
    });
    await settle(HOLD_ARMING_MS + 30);

    expect(onHoldEnd).not.toHaveBeenCalled();
  });

  test("registers the binding and clears it on teardown", async () => {
    const { view } = renderHold();

    expect(setModifierHold).toHaveBeenCalledWith({
      kind: "modifierOnly",
      modifiers: ["control", "option"],
    });

    act(() => {
      view.unmount();
    });
    expect(setModifierHold).toHaveBeenLastCalledWith({ kind: "off" });
  });

  test("registers nothing on a host that cannot watch a held set", () => {
    holdSupported = false;
    renderHold();

    expect(setModifierHold).not.toHaveBeenCalled();
  });

  /** Edges from the other bindings are other features' business. */
  test("ignores taps from the other bindings", async () => {
    const { onHoldStart } = renderHold();

    act(() => {
      emitHotkeyEvent?.({ kind: "fnPushToTalk", state: "down" });
      emitHotkeyEvent?.({ kind: "voiceModeChord", state: "down" });
    });
    await settle(HOLD_ARMING_MS + 30);

    expect(onHoldStart).not.toHaveBeenCalled();
  });
});
