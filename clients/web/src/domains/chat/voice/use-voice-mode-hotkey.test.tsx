import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { HotkeyEvent } from "@/runtime/hotkey";

let chordSupported = false;
let chordRegistrationSucceeds = true;
let emitHotkeyEvent: ((event: HotkeyEvent) => void) | null = null;
let emitRegistrationChange: ((active: boolean) => void) | null = null;

let onElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => onElectron,
}));

const setNativeVoiceModeChord = mock(async (_activator: unknown) => {
  return chordRegistrationSucceeds;
});
mock.module("@/runtime/hotkey", () => ({
  supportsVoiceModeChord: () => chordSupported,
  setNativeVoiceModeChord,
  subscribeToHotkeyEvents: (callback: (event: HotkeyEvent) => void) => {
    emitHotkeyEvent = callback;
    return () => {
      emitHotkeyEvent = null;
    };
  },
  subscribeToVoiceModeChordRegistration: (
    callback: (active: boolean) => void,
  ) => {
    emitRegistrationChange = callback;
    return () => {
      emitRegistrationChange = null;
    };
  },
}));

/**
 * The shared toggle the voice key's double tap also calls. Mocked rather than
 * exercised: what belongs to this hook is *that* a press reaches it, not what
 * happens afterwards, which `start-voice-request` owns and tests.
 */
const toggleVoiceFromSurface = mock(() => {});
mock.module("@/domains/chat/voice/live-voice/start-voice-request", () => ({
  toggleVoiceFromSurface,
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
  chordSupported = false;
  chordRegistrationSucceeds = true;
  onElectron = false;
  emitHotkeyEvent = null;
  emitRegistrationChange = null;
  setNativeVoiceModeChord.mockClear();
  toggleVoiceFromSurface.mockClear();
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

    expect(toggleVoiceFromSurface).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  test("fires with the composer focused, which is where users reach for voice", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    textarea.focus();
    renderVoiceModeHotkey();

    textarea.dispatchEvent(chordEvent());

    expect(toggleVoiceFromSurface).toHaveBeenCalledTimes(1);
    textarea.remove();
  });

  test("hands a press during a session to the same toggle, which ends it", () => {
    useLiveVoiceStore.getState().setState("listening");
    renderVoiceModeHotkey();

    window.dispatchEvent(chordEvent());

    expect(toggleVoiceFromSurface).toHaveBeenCalledTimes(1);
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

    expect(toggleVoiceFromSurface).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  test("does nothing when the shortcut is turned off", () => {
    writeVoiceModeActivator({ kind: "off" });
    renderVoiceModeHotkey();

    window.dispatchEvent(chordEvent());

    expect(toggleVoiceFromSurface).not.toHaveBeenCalled();
  });

  test("stays out of the way when disabled for the host", () => {
    renderVoiceModeHotkey({ enabled: false });

    window.dispatchEvent(chordEvent());

    expect(toggleVoiceFromSurface).not.toHaveBeenCalled();
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

    expect(toggleVoiceFromSurface).toHaveBeenCalledTimes(1);
  });

  describe("on the desktop app", () => {
    test("binds no chord, because the host binds Talk globally", () => {
      // A `globalShortcut` fires whether or not the app is focused, so a
      // second listener here would run the same press twice in the app.
      onElectron = true;
      renderVoiceModeHotkey();

      window.dispatchEvent(chordEvent());

      expect(toggleVoiceFromSurface).not.toHaveBeenCalled();
    });

    test("still binds the chord off Electron, where there is no globalShortcut", () => {
      onElectron = false;
      renderVoiceModeHotkey();

      window.dispatchEvent(chordEvent());

      expect(toggleVoiceFromSurface).toHaveBeenCalledTimes(1);
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
      expect(toggleVoiceFromSurface).not.toHaveBeenCalled();

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
      expect(toggleVoiceFromSurface).toHaveBeenCalledTimes(1);
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

      expect(toggleVoiceFromSurface).not.toHaveBeenCalled();
    });

    test("registers the bare-modifier binding with the helper's global hook", async () => {
      onElectron = true;
      chordSupported = true;
      setHostOS("windows");
      writeVoiceModeActivator({ kind: "modifierOnly", modifiers: ["option"] });
      renderVoiceModeHotkey();

      await waitFor(() => {
        expect(setNativeVoiceModeChord).toHaveBeenCalledWith({
          kind: "modifierOnly",
          modifiers: ["option"],
        });
      });
    });

    test("a completed native tap toggles on the down edge, from any app", async () => {
      onElectron = true;
      chordSupported = true;
      setHostOS("windows");
      writeVoiceModeActivator({ kind: "modifierOnly", modifiers: ["option"] });
      renderVoiceModeHotkey();
      await waitFor(() => {
        expect(setNativeVoiceModeChord).toHaveBeenCalled();
      });

      emitHotkeyEvent?.({ kind: "voiceModeChord", state: "down" });
      emitHotkeyEvent?.({ kind: "voiceModeChord", state: "up" });

      expect(toggleVoiceFromSurface).toHaveBeenCalledTimes(1);
    });

    test("the DOM tap stays quiet while native capture is live", async () => {
      onElectron = true;
      chordSupported = true;
      setHostOS("windows");
      writeVoiceModeActivator({ kind: "modifierOnly", modifiers: ["option"] });
      renderVoiceModeHotkey();
      await waitFor(() => {
        expect(setNativeVoiceModeChord).toHaveBeenCalled();
      });

      // The hook sees the same physical press; only the bridge event toggles.
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Alt",
          altKey: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Alt", cancelable: true }),
      );
      expect(toggleVoiceFromSurface).not.toHaveBeenCalled();

      // The host reporting the registration lost hands the tap back to the
      // focused-window listener.
      emitRegistrationChange?.(false);
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Alt",
          altKey: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Alt", cancelable: true }),
      );
      expect(toggleVoiceFromSurface).toHaveBeenCalledTimes(1);
    });

    test("a refused chord registration keeps the focused-window tap", async () => {
      onElectron = true;
      chordSupported = true;
      chordRegistrationSucceeds = false;
      setHostOS("windows");
      writeVoiceModeActivator({ kind: "modifierOnly", modifiers: ["option"] });
      renderVoiceModeHotkey();
      await waitFor(() => {
        expect(setNativeVoiceModeChord).toHaveBeenCalled();
      });

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Alt",
          altKey: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Alt", cancelable: true }),
      );

      expect(toggleVoiceFromSurface).toHaveBeenCalledTimes(1);
    });

    test("ignores native taps once the binding is not a bare modifier", async () => {
      onElectron = true;
      chordSupported = true;
      setHostOS("windows");
      writeVoiceModeActivator({ kind: "off" });
      renderVoiceModeHotkey();

      emitHotkeyEvent?.({ kind: "voiceModeChord", state: "down" });

      expect(toggleVoiceFromSurface).not.toHaveBeenCalled();
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

      expect(toggleVoiceFromSurface).not.toHaveBeenCalled();
    });
  });
});
