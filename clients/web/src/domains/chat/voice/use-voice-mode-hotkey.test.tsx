import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type { HotkeyEvent } from "@/runtime/hotkey";

let fnSupported = false;
let emitHotkeyEvent: ((event: HotkeyEvent) => void) | null = null;

mock.module("@/runtime/hotkey", () => ({
  supportsFnPushToTalk: () => fnSupported,
  setFnPushToTalkEnabled: async () => true,
  subscribeToHotkeyEvents: (callback: (event: HotkeyEvent) => void) => {
    emitHotkeyEvent = callback;
    return () => {
      emitHotkeyEvent = null;
    };
  },
}));

const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const {
  LS_VOICE_MODE_ACTIVATION_KEY,
  keyboardDefaultActivator,
  writeVoiceModeActivator,
} = await import("@/utils/voice-mode-activation");
const { useVoiceModeHotkey } =
  await import("@/domains/chat/voice/use-voice-mode-hotkey");

const entryHandler = mock(() => {});
const stop = mock(() => {});

/** The default chord, as the DOM would deliver it. */
function chordEvent(): KeyboardEvent {
  const activator = keyboardDefaultActivator();
  const modifiers = activator.kind === "key" ? activator.modifiers : [];
  return new KeyboardEvent("keydown", {
    key: "V",
    code: "KeyV",
    ctrlKey: modifiers.includes("control"),
    metaKey: modifiers.includes("command"),
    shiftKey: modifiers.includes("shift"),
    altKey: false,
    cancelable: true,
    bubbles: true,
  });
}

beforeEach(() => {
  fnSupported = false;
  emitHotkeyEvent = null;
  entryHandler.mockClear();
  stop.mockClear();
  localStorage.removeItem(LS_VOICE_MODE_ACTIVATION_KEY);
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore.getState().setEntryHandler(entryHandler);
  useLiveVoiceStore.getState().setControls({
    stop,
    release: () => {},
    interrupt: () => {},
    setMuted: () => {},
    setOutputMuted: () => {},
    updateConfig: () => {},
  } as unknown as Parameters<
    ReturnType<typeof useLiveVoiceStore.getState>["setControls"]
  >[0]);
});

afterEach(() => {
  cleanup();
  useLiveVoiceStore.getState().setEntryHandler(null);
  useLiveVoiceStore.getState().reset();
});

describe("useVoiceModeHotkey", () => {
  test("starts a session through the composer's entry handler", () => {
    renderHook(() => useVoiceModeHotkey());
    const event = chordEvent();

    window.dispatchEvent(event);

    expect(entryHandler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  test("fires with the composer focused — reaching for voice mid-sentence is the point", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    textarea.focus();
    renderHook(() => useVoiceModeHotkey());

    textarea.dispatchEvent(chordEvent());

    expect(entryHandler).toHaveBeenCalledTimes(1);
    textarea.remove();
  });

  test("ends the session instead of starting a second one", () => {
    useLiveVoiceStore.getState().setState("listening");
    renderHook(() => useVoiceModeHotkey());

    window.dispatchEvent(chordEvent());

    expect(stop).toHaveBeenCalledTimes(1);
    expect(entryHandler).not.toHaveBeenCalled();
  });

  test("ignores a chord that is not the binding", () => {
    renderHook(() => useVoiceModeHotkey());
    const event = new KeyboardEvent("keydown", {
      key: "K",
      code: "KeyK",
      metaKey: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(entryHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  test("does nothing when the shortcut is turned off", () => {
    writeVoiceModeActivator({ kind: "off" });
    renderHook(() => useVoiceModeHotkey());

    window.dispatchEvent(chordEvent());

    expect(entryHandler).not.toHaveBeenCalled();
  });

  test("stays out of the way when disabled for the host", () => {
    renderHook(() => useVoiceModeHotkey({ enabled: false }));

    window.dispatchEvent(chordEvent());

    expect(entryHandler).not.toHaveBeenCalled();
  });

  describe("Fn", () => {
    beforeEach(() => {
      fnSupported = true;
    });

    test("toggles on the down edge and ignores the release", () => {
      renderHook(() => useVoiceModeHotkey());

      emitHotkeyEvent?.({ kind: "fnPushToTalk", state: "down" });
      expect(entryHandler).toHaveBeenCalledTimes(1);

      // The user has already lifted the key that started the session; the
      // release edge only ever meant something to push to talk.
      emitHotkeyEvent?.({ kind: "fnPushToTalk", state: "up" });
      expect(entryHandler).toHaveBeenCalledTimes(1);
    });

    test("ignores host Fn events once the binding is a chord", () => {
      writeVoiceModeActivator(keyboardDefaultActivator());
      renderHook(() => useVoiceModeHotkey());

      emitHotkeyEvent?.({ kind: "fnPushToTalk", state: "down" });

      expect(entryHandler).not.toHaveBeenCalled();
    });
  });
});
