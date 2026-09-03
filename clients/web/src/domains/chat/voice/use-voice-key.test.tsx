import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { HotkeySelection } from "@vellumai/ipc-contract";

import type { HotkeyEvent } from "@/runtime/hotkey";
import type { VoiceKey } from "@/utils/voice-key";

let holdSupported = true;
let registrationSucceeds = true;
let emitHotkeyEvent: ((event: HotkeyEvent) => void) | null = null;
let frontSelection: HotkeySelection | null = null;
const setModifierHold = mock(async (_hold: unknown) => ({
  ok: true as const,
  enabled: registrationSucceeds,
}));
const readFrontSelection = mock(async () => frontSelection);

mock.module("@/runtime/hotkey", () => ({
  supportsModifierHold: () => holdSupported,
  setModifierHold,
  readFrontSelection,
  subscribeToHotkeyEvents: (callback: (event: HotkeyEvent) => void) => {
    emitHotkeyEvent = callback;
    return () => {
      emitHotkeyEvent = null;
    };
  },
}));

let inputMonitoringStatus = "granted";
const requestSystemPermission = mock(async (_kind: string) => null);
mock.module("@/runtime/system-permissions", () => ({
  getSystemPermissionsState: async () => ({
    inputMonitoring: { status: inputMonitoringStatus },
  }),
  requestSystemPermission,
}));

const { useVoiceKey } = await import("@/domains/chat/voice/use-voice-key");
const { DOUBLE_TAP_GAP_MS, HOLD_ARMING_MS } =
  await import("@/domains/chat/voice/voice-key-gestures");
type HoldStart = Parameters<
  Parameters<typeof useVoiceKey>[0]["onHoldStart"]
>[0];

const FN: VoiceKey = { kind: "modifierOnly", modifiers: ["function"] };

const press = () => {
  act(() => {
    emitHotkeyEvent?.({ kind: "modifierHold", state: "down" });
  });
};

const release = (reason: "released" | "chord" = "released") => {
  act(() => {
    emitHotkeyEvent?.({ kind: "modifierHold", state: "up", reason });
  });
};

const settle = async (ms: number) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

const tap = async () => {
  press();
  await settle(HOLD_ARMING_MS / 4);
  release();
};

/** What the start the hook reported will resolve its selection to. */
const startedOver = async (
  onHoldStart: ReturnType<typeof mock<(start: HoldStart) => void>>,
): Promise<HotkeySelection | null> => {
  const start = onHoldStart.mock.calls[0]?.[0];
  if (!start) {
    throw new Error("the hold never started");
  }
  return start.selection;
};

const renderKey = (key: VoiceKey = FN) => {
  const onHoldStart = mock((_start: HoldStart) => {});
  const onHoldEnd = mock(() => {});
  const onDoubleTap = mock(() => {});
  const onRegistered = mock((_registered: boolean) => {});
  const view = renderHook(
    (props: { key: VoiceKey }) =>
      useVoiceKey({
        key: props.key,
        onHoldStart,
        onHoldEnd,
        onDoubleTap,
        onRegistered,
      }),
    { initialProps: { key } },
  );
  return { onHoldStart, onHoldEnd, onDoubleTap, onRegistered, view };
};

describe("the voice key", () => {
  beforeEach(() => {
    holdSupported = true;
    registrationSucceeds = true;
    frontSelection = null;
    inputMonitoringStatus = "granted";
    setModifierHold.mockClear();
    readFrontSelection.mockClear();
    requestSystemPermission.mockClear();
  });

  afterEach(() => {
    cleanup();
    emitHotkeyEvent = null;
  });

  test("opens the microphone once the hold outlasts the arming delay", async () => {
    const { onHoldStart } = renderKey();

    press();
    expect(onHoldStart).not.toHaveBeenCalled();

    await settle(HOLD_ARMING_MS + 30);
    expect(onHoldStart).toHaveBeenCalledTimes(1);
  });

  test("closes it on release", async () => {
    const { onHoldStart, onHoldEnd } = renderKey();

    press();
    await settle(HOLD_ARMING_MS + 30);
    release();

    expect(onHoldStart).toHaveBeenCalledTimes(1);
    expect(onHoldEnd).toHaveBeenCalledTimes(1);
  });

  test("hands the selection the hold armed over to the start", async () => {
    frontSelection = {
      text: "the powerhouse of the cell",
      truncated: false,
      editable: false,
    };
    const { onHoldStart } = renderKey();
    press();
    await settle(HOLD_ARMING_MS + 20);
    expect(await startedOver(onHoldStart)).toEqual(frontSelection);
    release();
  });

  /**
   * Every chord on the key passes through the held state on its way to its
   * own key. A read on each press would query, and on the copy path type
   * into, whatever the user is working in, for a hold that was never one.
   */
  test("asks for the selection only once the hold has armed", async () => {
    renderKey();

    press();
    await settle(HOLD_ARMING_MS / 3);
    expect(readFrontSelection).not.toHaveBeenCalled();
    release();
    await settle(HOLD_ARMING_MS + 30);
    expect(readFrontSelection).not.toHaveBeenCalled();

    press();
    await settle(HOLD_ARMING_MS + 30);
    expect(readFrontSelection).toHaveBeenCalledTimes(1);
    release();
  });

  test("never opens it for a hold that ends inside the delay", async () => {
    const { onHoldStart, onHoldEnd } = renderKey();

    press();
    await settle(HOLD_ARMING_MS / 3);
    release();
    await settle(HOLD_ARMING_MS + 30);

    expect(onHoldStart).not.toHaveBeenCalled();
    expect(onHoldEnd).not.toHaveBeenCalled();
  });

  test("a double tap is a call, and a single tap is nothing", async () => {
    const { onDoubleTap, onHoldStart } = renderKey();

    await tap();
    await settle(DOUBLE_TAP_GAP_MS * 2);
    expect(onDoubleTap).not.toHaveBeenCalled();

    await tap();
    await settle(DOUBLE_TAP_GAP_MS / 3);
    await tap();
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    expect(onHoldStart).not.toHaveBeenCalled();
  });

  /** Fn+arrow comes and goes inside the delay too, and is neither gesture. */
  test("a chord passing through is neither a tap nor a hold", async () => {
    const { onDoubleTap, onHoldStart } = renderKey();

    press();
    await settle(HOLD_ARMING_MS / 4);
    release("chord");
    await settle(DOUBLE_TAP_GAP_MS / 3);
    await tap();

    expect(onDoubleTap).not.toHaveBeenCalled();
    expect(onHoldStart).not.toHaveBeenCalled();
  });

  /**
   * The span is a live microphone, so unmounting mid-hold has to close it.
   * Nothing else is going to: the subscription is gone with the effect.
   */
  test("closes an open hold when the binding goes away", async () => {
    const { onHoldEnd, view } = renderKey();

    press();
    await settle(HOLD_ARMING_MS + 30);
    act(() => {
      view.unmount();
    });

    expect(onHoldEnd).toHaveBeenCalledTimes(1);
  });

  test("registers the key and clears it on teardown", async () => {
    const { view } = renderKey();

    expect(setModifierHold).toHaveBeenCalledWith({
      kind: "modifierOnly",
      modifiers: ["function"],
    });

    act(() => {
      view.unmount();
    });
    expect(setModifierHold).toHaveBeenLastCalledWith({ kind: "off" });
  });

  test("re-registers when the key changes, and clears it for off", async () => {
    const { view } = renderKey();

    view.rerender({
      key: { kind: "modifierOnly", modifiers: ["control", "option"] },
    });
    expect(setModifierHold).toHaveBeenLastCalledWith({
      kind: "modifierOnly",
      modifiers: ["control", "option"],
    });

    view.rerender({ key: { kind: "off" } });
    expect(setModifierHold).toHaveBeenLastCalledWith({ kind: "off" });
  });

  test("reports whether the host took the key", async () => {
    const { onRegistered } = renderKey();
    await settle(0);
    expect(onRegistered).toHaveBeenLastCalledWith(true);
  });

  test("reports a refused key", async () => {
    registrationSucceeds = false;
    const { onRegistered } = renderKey();
    await settle(0);
    expect(onRegistered).toHaveBeenLastCalledWith(false);
  });

  test("registers nothing on a host that cannot watch a held set", () => {
    holdSupported = false;
    const { onRegistered } = renderKey();

    expect(setModifierHold).not.toHaveBeenCalled();
    expect(onRegistered).toHaveBeenLastCalledWith(false);
  });

  /**
   * Arming the key is what asks for Input Monitoring, once per launch: the
   * grant is for noticing the press, so the press itself can never be the
   * moment to ask.
   */
  test("asks for Input Monitoring when the key is armed without it", async () => {
    inputMonitoringStatus = "not-determined";
    const { view } = renderKey();
    await settle(0);
    expect(requestSystemPermission).toHaveBeenCalledWith("inputMonitoring");

    // Once. A second registration in the same launch asks nothing more.
    view.rerender({
      key: { kind: "modifierOnly", modifiers: ["control", "option"] },
    });
    await settle(0);
    expect(requestSystemPermission).toHaveBeenCalledTimes(1);
  });

  /** Edges from the other bindings are other features' business. */
  test("ignores taps from the other bindings", async () => {
    const { onHoldStart } = renderKey();

    act(() => {
      emitHotkeyEvent?.({ kind: "voiceModeChord", state: "down" });
    });
    await settle(HOLD_ARMING_MS + 30);

    expect(onHoldStart).not.toHaveBeenCalled();
  });
});
