import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { HotkeyEvent } from "@/runtime/hotkey";

let fnSupported = false;
let fnRegistrationSucceeds = true;
let emitHotkeyEvent: ((event: HotkeyEvent) => void) | null = null;

mock.module("@/runtime/hotkey", () => ({
  supportsFnPushToTalk: () => fnSupported,
  setFnPushToTalkEnabled: async (enable: boolean) =>
    enable ? fnRegistrationSucceeds : true,
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
const { clearPendingVoiceModeStart, consumePendingVoiceModeStart } =
  await import("@/domains/chat/voice/pending-voice-start");

/** The hook navigates when nothing is registered, so it needs a router. */
function renderVoiceModeHotkey(options?: { enabled?: boolean }) {
  return renderHook(() => useVoiceModeHotkey(options), {
    wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
  });
}

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
  fnRegistrationSucceeds = true;
  clearPendingVoiceModeStart();
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
  clearPendingVoiceModeStart();
  useLiveVoiceStore.getState().setEntryHandler(null);
  useLiveVoiceStore.getState().reset();
});

describe("useVoiceModeHotkey", () => {
  test("starts a session through the composer's entry handler", () => {
    renderVoiceModeHotkey();
    const event = chordEvent();

    window.dispatchEvent(event);

    expect(entryHandler).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  test("fires with the composer focused, which is where users reach for voice", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    textarea.focus();
    renderVoiceModeHotkey();

    textarea.dispatchEvent(chordEvent());

    expect(entryHandler).toHaveBeenCalledTimes(1);
    textarea.remove();
  });

  test("ends the session instead of starting a second one", () => {
    useLiveVoiceStore.getState().setState("listening");
    renderVoiceModeHotkey();

    window.dispatchEvent(chordEvent());

    expect(stop).toHaveBeenCalledTimes(1);
    expect(entryHandler).not.toHaveBeenCalled();
  });

  test("ignores a chord that is not the binding", () => {
    renderVoiceModeHotkey();
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
    renderVoiceModeHotkey();

    window.dispatchEvent(chordEvent());

    expect(entryHandler).not.toHaveBeenCalled();
  });

  test("stays out of the way when disabled for the host", () => {
    renderVoiceModeHotkey({ enabled: false });

    window.dispatchEvent(chordEvent());

    expect(entryHandler).not.toHaveBeenCalled();
  });

  test("parks the start for the composer when no composer is registered", () => {
    // Settings, Library, the app viewer: no composer means no guarded entry
    // flow to call, so the press is handed to the one that mounts next.
    useLiveVoiceStore.getState().setEntryHandler(null);
    renderVoiceModeHotkey();

    // Navigation re-renders the router, so let React flush it.
    act(() => {
      window.dispatchEvent(chordEvent());
    });

    expect(entryHandler).not.toHaveBeenCalled();
    expect(consumePendingVoiceModeStart()).toBe(true);
  });

  test("parks nothing while a composer is registered", () => {
    renderVoiceModeHotkey();

    window.dispatchEvent(chordEvent());

    expect(entryHandler).toHaveBeenCalledTimes(1);
    expect(consumePendingVoiceModeStart()).toBe(false);
  });

  describe("Fn", () => {
    beforeEach(() => {
      fnSupported = true;
    });

    test("toggles on the down edge and ignores the release", () => {
      renderVoiceModeHotkey();

      emitHotkeyEvent?.({ kind: "fnPushToTalk", state: "down" });
      expect(entryHandler).toHaveBeenCalledTimes(1);

      // The user has already lifted the key that started the session; the
      // release edge only ever meant something to push to talk.
      emitHotkeyEvent?.({ kind: "fnPushToTalk", state: "up" });
      expect(entryHandler).toHaveBeenCalledTimes(1);
    });

    test("falls back to the chord when the host refuses the registration", async () => {
      // No helper, or Input Monitoring ungranted. Fn never reaches the DOM, so
      // without the fallback the shortcut reads as bound and does nothing.
      fnRegistrationSucceeds = false;
      renderVoiceModeHotkey();

      await waitFor(() => {
        window.dispatchEvent(chordEvent());
        expect(entryHandler).toHaveBeenCalledTimes(1);
      });
    });

    test("ignores host Fn events once the binding is a chord", () => {
      writeVoiceModeActivator(keyboardDefaultActivator());
      renderVoiceModeHotkey();

      emitHotkeyEvent?.({ kind: "fnPushToTalk", state: "down" });

      expect(entryHandler).not.toHaveBeenCalled();
    });
  });
});
