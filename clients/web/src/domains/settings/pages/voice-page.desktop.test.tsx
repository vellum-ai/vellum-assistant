import type { FnKeyState } from "@vellumai/ipc-contract";

import type { UseManagedVoiceSelection } from "@/components/speech/use-managed-voice-selection";
import type { UseSttLanguageSelection } from "@/components/speech/use-stt-language-selection";
/**
 * The voice key card, on the desktop host that has a helper to watch it.
 *
 * The card offers Fn, a modifier set of the user's own, and Off. It replaces
 * the voice mode shortcut card there: one key carries every gesture, so the
 * chord rail is not on offer.
 *
 * Drives the real card with the Electron host mocked at the runtime-wrapper
 * seam: `is-electron` reports a desktop host, `hotkey` reports a helper that
 * can watch a held set, and `system-permissions` an Input Monitoring grant.
 * Follows single-file `bun test` isolation.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "asst-test",
}));
mock.module("@/components/speech/use-managed-voice-selection", () => ({
  useManagedVoiceSelection: (): UseManagedVoiceSelection => ({
    available: false,
    isByok: false,
    settled: true,
    voices: [],
    currentModel: "",
    defaultModel: "",
    selectModel: () => {},
    selecting: false,
  }),
}));
mock.module("@/components/speech/use-stt-language-selection", () => ({
  useSttLanguageSelection: (): UseSttLanguageSelection => ({
    available: false,
    currentCode: "multi",
    configuredProviderId: "deepgram",
    selectLanguage: () => {},
    selecting: false,
  }),
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => true,
}));
let fnKeyState: FnKeyState | null = null;
let fnKeyStateReads = 0;
let keyboardSettingsOpens = 0;
mock.module("@/runtime/hotkey", () => ({
  supportsModifierHold: () => true,
  subscribeToHotkeyEvents: () => () => {},
  readFnKeyState: async () => {
    fnKeyStateReads += 1;
    return fnKeyState;
  },
  openKeyboardSettings: async () => {
    keyboardSettingsOpens += 1;
  },
}));

let inputMonitoringStatus = "granted";
const permissionRequests: string[] = [];
mock.module("@/runtime/system-permissions", () => ({
  getSystemPermissionsState: async () => ({
    inputMonitoring: { status: inputMonitoringStatus },
  }),
  requestSystemPermission: async (kind: string) => {
    permissionRequests.push(kind);
    return null;
  },
}));

mock.module("@/runtime/hotkeys", () => ({
  getHotkeys: async () => [],
  setHotkey: async () => {},
  onHotkeysChange: () => () => {},
}));

import { VoiceSections } from "@/domains/settings/pages/voice-page";

function renderPage() {
  // The page reads daemon config now (the turn-taking row), so it needs a
  // client. `retry: false` keeps a miss from re-fetching through the test.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <VoiceSections />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function storedKey() {
  return JSON.parse(localStorage.getItem("vellum:voice:voiceKey") ?? "null");
}

/** The chip row is the recording zone; key events go to it. */
function recordingZone() {
  const zone = screen.getByRole("button", { name: "Fn" }).parentElement;
  if (!zone) {
    throw new Error("recording zone not found");
  }
  return zone;
}

beforeEach(() => {
  localStorage.clear();
  inputMonitoringStatus = "granted";
  permissionRequests.length = 0;
  fnKeyState = null;
  fnKeyStateReads = 0;
  keyboardSettingsOpens = 0;
});

describe("VoiceSections voice key on the desktop host", () => {
  test("offers Fn, a custom set, and Off, with Fn chosen out of the box", () => {
    renderPage();

    expect(screen.getByRole("button", { name: "Fn" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Custom" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Off" })).toBeTruthy();
    expect(screen.queryByText("Voice Mode Shortcut")).toBeNull();
  });

  test("choosing Off stores an explicit off, and Fn brings it back", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Off" }));
    expect(storedKey()).toEqual({ kind: "off" });

    fireEvent.click(screen.getByRole("button", { name: "Fn" }));
    expect(storedKey()).toEqual({
      kind: "modifierOnly",
      modifiers: ["function"],
    });
  });

  test("records a modifier set of two or more as the custom key", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    const zone = recordingZone();

    fireEvent.keyDown(zone, { key: "Control", ctrlKey: true });
    fireEvent.keyDown(zone, { key: "Alt", ctrlKey: true, altKey: true });
    fireEvent.keyUp(zone, { key: "Alt", ctrlKey: true });
    fireEvent.keyUp(zone, { key: "Control" });

    expect(storedKey()).toEqual({
      kind: "modifierOnly",
      modifiers: ["control", "option"],
    });
    expect(screen.getByRole("button", { name: "Ctrl+Alt" })).toBeTruthy();
  });

  /**
   * One modifier alone is held on the way to every capital letter, so it is
   * refused with a word about what is missing rather than bound.
   */
  test("refuses a single modifier and says what is missing", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    const zone = recordingZone();

    fireEvent.keyDown(zone, { key: "Shift", shiftKey: true });
    fireEvent.keyUp(zone, { key: "Shift" });

    expect(
      screen.getByText(
        "Hold two or more of Cmd, Ctrl, Option, and Shift, then let go.",
      ),
    ).toBeTruthy();
    expect(storedKey()).toBe(null);
  });

  test("choosing a key asks for Input Monitoring", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Fn" }));

    await waitFor(() =>
      expect(permissionRequests).toContain("inputMonitoring"),
    );
  });

  test("offers the grant again while Input Monitoring is missing", async () => {
    inputMonitoringStatus = "denied";
    renderPage();

    const allow = await screen.findByRole("button", {
      name: "Allow Input Monitoring",
    });
    fireEvent.click(allow);

    await waitFor(() =>
      expect(permissionRequests).toContain("inputMonitoring"),
    );
  });

  /**
   * A Globe key sent to No Action is dropped before any app hears it, so the
   * grant reads green while the key stays dead. The card names the setting
   * and opens the pane it lives in.
   */
  test("names a Globe key sent to No Action and opens Keyboard settings", async () => {
    fnKeyState = {
      fnRemappedToNoAction: true,
      fnRemappedTo: null,
      fnUsageType: 0,
    };
    renderPage();

    await screen.findByText(
      "Fn is set to No Action under Modifier Keys in Keyboard settings, so Vellum cannot see it.",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Keyboard Settings" }),
    );

    await waitFor(() => expect(keyboardSettingsOpens).toBe(1));
  });

  test("notes the dictation double press only when Fn is set to start it", async () => {
    fnKeyState = {
      fnRemappedToNoAction: false,
      fnRemappedTo: null,
      fnUsageType: 3,
    };
    const { unmount } = renderPage();

    await screen.findByText(
      "Pressing Fn twice starts macOS Dictation, the same press that starts a call.",
    );
    expect(
      screen.getByRole("button", { name: "Open Keyboard Settings" }),
    ).toBeTruthy();
    unmount();

    fnKeyState = { ...fnKeyState, fnUsageType: 0 };
    fnKeyStateReads = 0;
    renderPage();

    await waitFor(() => expect(fnKeyStateReads).toBe(1));
    expect(
      screen.queryByText(
        "Pressing Fn twice starts macOS Dictation, the same press that starts a call.",
      ),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open Keyboard Settings" }),
    ).toBeNull();
  });

  test("says nothing about Fn when the host cannot read its settings", async () => {
    renderPage();

    await waitFor(() => expect(fnKeyStateReads).toBe(1));
    expect(
      screen.queryByRole("button", { name: "Open Keyboard Settings" }),
    ).toBeNull();
  });
});
