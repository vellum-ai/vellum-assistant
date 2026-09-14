/**
 * When the call's chords are armed and when they are not, which is the whole
 * of what this hook owns.
 *
 * It matters more than a binding usually would: while the binding is armed the
 * host *takes* these presses, so a binding left up outside a call is Option+S
 * silently doing nothing in the user's own applications.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { ChordBinding, HotkeyEvent } from "@vellumai/ipc-contract";

let chordsSupported = true;
let emitHotkeyEvent: ((event: HotkeyEvent) => void) | null = null;
const setChordBinding = mock(async (_binding: ChordBinding) => ({
  ok: true as const,
  enabled: true,
}));
mock.module("@/runtime/hotkey", () => ({
  supportsChords: () => chordsSupported,
  setChordBinding,
  subscribeToHotkeyEvents: (callback: (event: HotkeyEvent) => void) => {
    emitHotkeyEvent = callback;
    return () => {
      emitHotkeyEvent = null;
    };
  },
}));

const handleCallChord = mock((_key: string) => {});
/**
 * Stand-ins for the two bindings the real builder returns, one per answer it
 * is asked. Sentinels rather than a copy of the builder: what this hook owns is
 * which answer it asks with and when, and the keys are the builder's own test.
 */
const ALL_CHORDS: ChordBinding = {
  kind: "chord",
  modifiers: ["option"],
  keys: ["all"],
};
const MUTE_CHORDS: ChordBinding = {
  kind: "chord",
  modifiers: ["option"],
  keys: ["mutes"],
};
const callChords = mock(
  (canBeShownTheScreen: boolean): ChordBinding =>
    canBeShownTheScreen ? ALL_CHORDS : MUTE_CHORDS,
);
mock.module("@/domains/chat/voice/live-voice/call-chords", () => ({
  handleCallChord,
  callChords,
}));

let canBeShownTheScreen = false;
mock.module(
  "@/domains/chat/voice/live-voice/screen-share-availability",
  () => ({
    liveVoiceCanBeShownTheScreen: () => canBeShownTheScreen,
  }),
);

const { useCallChords } =
  await import("@/domains/chat/voice/live-voice/use-call-chords");
const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");

/** Move the session, which is what the hook is subscribed through. */
const setCall = (running: boolean): void => {
  act(() => {
    canBeShownTheScreen = running;
    useLiveVoiceStore.getState().setState(running ? "listening" : "idle");
  });
};

const armedWith = (): ChordBinding | undefined =>
  setChordBinding.mock.calls.at(-1)?.[0];

describe("the call's chords", () => {
  beforeEach(() => {
    chordsSupported = true;
    canBeShownTheScreen = false;
    setChordBinding.mockClear();
    handleCallChord.mockClear();
    callChords.mockClear();
    useLiveVoiceStore.getState().setState("idle");
  });

  afterEach(() => {
    cleanup();
    emitHotkeyEvent = null;
    useLiveVoiceStore.getState().setState("idle");
  });

  test("arms nothing until there is a call", () => {
    renderHook(() => useCallChords());

    expect(setChordBinding).not.toHaveBeenCalled();
  });

  test("arms them for a call that starts", () => {
    renderHook(() => useCallChords());

    setCall(true);

    expect(callChords).toHaveBeenLastCalledWith(true);
    expect(armedWith()).toBe(ALL_CHORDS);
  });

  /**
   * The mutes are the call's whatever it can be shown. The share and the pen
   * are armed on the same answer the pill offers Share on, and follow it.
   */
  test("arms only the mutes for a call that cannot be shown the screen", () => {
    renderHook(() => useCallChords());

    act(() => {
      useLiveVoiceStore.getState().setState("listening");
    });

    expect(callChords).toHaveBeenLastCalledWith(false);
    expect(armedWith()).toBe(MUTE_CHORDS);
  });

  test("adds the share and the pen when the call can be shown the screen", () => {
    renderHook(() => useCallChords());
    act(() => {
      useLiveVoiceStore.getState().setState("listening");
    });

    act(() => {
      canBeShownTheScreen = true;
      // The answer is read through the store, so a change to it reaches the
      // hook with the next store update, the way the real conjunction's terms do.
      useLiveVoiceStore.getState().setState("speaking");
    });

    expect(callChords).toHaveBeenLastCalledWith(true);
    expect(armedWith()).toBe(ALL_CHORDS);
  });

  /**
   * The keys go back to the user the moment the call does. A binding left up
   * is the host swallowing Option+S in their editor.
   */
  test("clears them when the call ends", () => {
    renderHook(() => useCallChords());
    setCall(true);
    setChordBinding.mockClear();

    setCall(false);

    expect(armedWith()).toEqual({ kind: "off" });
  });

  test("clears them when the window goes away mid-call", () => {
    const view = renderHook(() => useCallChords());
    setCall(true);
    setChordBinding.mockClear();

    act(() => {
      view.unmount();
    });

    expect(armedWith()).toEqual({ kind: "off" });
  });

  test("hands a chord to the action it names", () => {
    renderHook(() => useCallChords());
    setCall(true);

    act(() => {
      emitHotkeyEvent?.({ kind: "chord", state: "down", key: "s" });
    });

    expect(handleCallChord).toHaveBeenCalledWith("s");
  });

  /** The hold's edges are the voice key's business, not this binding's. */
  test("ignores the other bindings' events", () => {
    renderHook(() => useCallChords());
    setCall(true);

    act(() => {
      emitHotkeyEvent?.({ kind: "modifierHold", state: "down" });
      emitHotkeyEvent?.({ kind: "voiceModeChord", state: "down" });
    });

    expect(handleCallChord).not.toHaveBeenCalled();
  });

  test("arms nothing on a host that cannot watch a chord", () => {
    chordsSupported = false;
    renderHook(() => useCallChords());

    setCall(true);

    expect(setChordBinding).not.toHaveBeenCalled();
  });
});
