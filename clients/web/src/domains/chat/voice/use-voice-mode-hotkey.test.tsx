import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { HotkeyEvent } from "@/runtime/hotkey";

let fnSupported = false;
let fnRegistrationSucceeds = true;
let emitHotkeyEvent: ((event: HotkeyEvent) => void) | null = null;

let onElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => onElectron,
}));

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

/**
 * The shared entry the companion surface's Talk also calls. Mocked rather than
 * exercised: what belongs to this hook is *that* a press reaches it, not what
 * happens afterwards, which `start-voice-request` owns and tests.
 */
const startVoiceFromSurface = mock(() => {});
mock.module("@/domains/chat/voice/live-voice/start-voice-request", () => ({
  startVoiceFromSurface,
}));

const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const {
  LS_VOICE_MODE_ACTIVATION_KEY,
  keyboardDefaultActivator,
  writeVoiceModeActivator,
} = await import("@/utils/voice-mode-activation");
const { FN_PTT_ACTIVATOR } = await import("@/utils/ptt-activator");
const { useVoiceModeHotkey } =
  await import("@/domains/chat/voice/use-voice-mode-hotkey");

/** The hook navigates when nothing is registered, so it needs a router. */
function renderVoiceModeHotkey(options?: { enabled?: boolean }) {
  return renderHook(() => useVoiceModeHotkey(options), {
    wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
  });
}

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
  onElectron = false;
  emitHotkeyEvent = null;
  startVoiceFromSurface.mockClear();
  stop.mockClear();
  localStorage.removeItem(LS_VOICE_MODE_ACTIVATION_KEY);
  useLiveVoiceStore.getState().reset();
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
  useLiveVoiceStore.getState().reset();
});

describe("useVoiceModeHotkey", () => {
  test("starts a session through the shared surface entry", () => {
    renderVoiceModeHotkey();
    const event = chordEvent();

    window.dispatchEvent(event);

    expect(startVoiceFromSurface).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  test("fires with the composer focused, which is where users reach for voice", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    textarea.focus();
    renderVoiceModeHotkey();

    textarea.dispatchEvent(chordEvent());

    expect(startVoiceFromSurface).toHaveBeenCalledTimes(1);
    textarea.remove();
  });

  test("ends the session instead of starting a second one", () => {
    useLiveVoiceStore.getState().setState("listening");
    renderVoiceModeHotkey();

    window.dispatchEvent(chordEvent());

    expect(stop).toHaveBeenCalledTimes(1);
    expect(startVoiceFromSurface).not.toHaveBeenCalled();
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

    expect(startVoiceFromSurface).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  test("does nothing when the shortcut is turned off", () => {
    writeVoiceModeActivator({ kind: "off" });
    renderVoiceModeHotkey();

    window.dispatchEvent(chordEvent());

    expect(startVoiceFromSurface).not.toHaveBeenCalled();
  });

  test("stays out of the way when disabled for the host", () => {
    renderVoiceModeHotkey({ enabled: false });

    window.dispatchEvent(chordEvent());

    expect(startVoiceFromSurface).not.toHaveBeenCalled();
  });

  test("starts the same way off a chat route as on one", () => {
    // Settings, Library, the app viewer. The press means the same thing from
    // all of them, so there is no route branch here to get wrong: the entry
    // is handed the request and owns the navigation and the parking.
    renderVoiceModeHotkey();

    // Navigation re-renders the router, so let React flush it.
    act(() => {
      window.dispatchEvent(chordEvent());
    });

    expect(startVoiceFromSurface).toHaveBeenCalledTimes(1);
  });

  describe("Fn", () => {
    beforeEach(() => {
      fnSupported = true;
    });

    /**
     * Fn only ever fires because the user went to Settings and chose it. It is
     * not the default and cannot become one: the Globe key belongs to the OS
     * (Start Dictation, on a lot of machines) and to whatever the user has it
     * doing, so an install that took it would be one press doing two things.
     */
    test("does nothing until it has been chosen in settings", () => {
      renderVoiceModeHotkey();

      emitHotkeyEvent?.({ kind: "fnPushToTalk", state: "down" });

      expect(startVoiceFromSurface).not.toHaveBeenCalled();
    });

    test("toggles on the down edge and ignores the release", () => {
      writeVoiceModeActivator(FN_PTT_ACTIVATOR);
      renderVoiceModeHotkey();

      emitHotkeyEvent?.({ kind: "fnPushToTalk", state: "down" });
      expect(startVoiceFromSurface).toHaveBeenCalledTimes(1);

      // The user has already lifted the key that started the session; the
      // release edge only ever meant something to push to talk.
      emitHotkeyEvent?.({ kind: "fnPushToTalk", state: "up" });
      expect(startVoiceFromSurface).toHaveBeenCalledTimes(1);
    });

    test("a refused registration binds no chord in its place", async () => {
      // No helper, or Input Monitoring ungranted. There is nothing to fall
      // back to and nothing to fall back for: the host's global Talk shortcut
      // is the keyboard way in, and unlike Fn it needs no permission grant.
      onElectron = true;
      fnRegistrationSucceeds = false;
      renderVoiceModeHotkey();

      await waitFor(() => {
        expect(fnRegistrationSucceeds).toBe(false);
      });
      window.dispatchEvent(chordEvent());

      expect(startVoiceFromSurface).not.toHaveBeenCalled();
    });

    test("ignores host Fn events once the binding is a chord", () => {
      writeVoiceModeActivator(keyboardDefaultActivator());
      renderVoiceModeHotkey();

      emitHotkeyEvent?.({ kind: "fnPushToTalk", state: "down" });

      expect(startVoiceFromSurface).not.toHaveBeenCalled();
    });
  });

  describe("on the desktop app", () => {
    test("binds no chord, because the host binds Talk globally", () => {
      // A `globalShortcut` fires whether or not the app is focused, so a
      // second listener here would run the same press twice in the app.
      onElectron = true;
      renderVoiceModeHotkey();

      window.dispatchEvent(chordEvent());

      expect(startVoiceFromSurface).not.toHaveBeenCalled();
    });

    test("still binds the chord off Electron, where there is no globalShortcut", () => {
      onElectron = false;
      renderVoiceModeHotkey();

      window.dispatchEvent(chordEvent());

      expect(startVoiceFromSurface).toHaveBeenCalledTimes(1);
    });
  });

  describe("bare-modifier taps on the Windows desktop host", () => {
    const setHostOS = (hostOS: string | undefined) => {
      const w = window as unknown as { vellum?: { hostOS?: string } };
      if (hostOS === undefined) {
        delete w.vellum;
      } else {
        w.vellum = { hostOS };
      }
    };

    afterEach(() => {
      setHostOS(undefined);
    });

    test("a clean tap toggles on the release edge; a chord passing through does not", () => {
      onElectron = true;
      setHostOS("windows");
      writeVoiceModeActivator({ kind: "modifierOnly", modifiers: ["control"] });
      renderVoiceModeHotkey();

      // Ctrl+C on its way through: the C keydown disarms the pending tap.
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Control",
          ctrlKey: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "c",
          ctrlKey: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Control", cancelable: true }),
      );
      expect(startVoiceFromSurface).not.toHaveBeenCalled();

      // Press and release with nothing in between fires once, on release.
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Control",
          ctrlKey: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Control", cancelable: true }),
      );
      expect(startVoiceFromSurface).toHaveBeenCalledTimes(1);
    });

    test("losing window focus mid-hold disarms the tap", () => {
      onElectron = true;
      setHostOS("windows");
      writeVoiceModeActivator({ kind: "modifierOnly", modifiers: ["option"] });
      renderVoiceModeHotkey();

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Alt",
          altKey: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Alt", cancelable: true }),
      );

      expect(startVoiceFromSurface).not.toHaveBeenCalled();
    });

    test("stays rejected on the macOS desktop host", () => {
      onElectron = true;
      setHostOS("macos");
      writeVoiceModeActivator({ kind: "modifierOnly", modifiers: ["control"] });
      renderVoiceModeHotkey();

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Control",
          ctrlKey: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Control", cancelable: true }),
      );

      expect(startVoiceFromSurface).not.toHaveBeenCalled();
    });
  });
});
