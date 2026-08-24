/**
 * The desktop-host voice mode shortcut card.
 *
 * On the desktop app the card offers Fn (through the host helper), a recorded
 * Talk chord (through `settings.hotkeys`), and Off. Off is the answer
 * "nothing starts Talk by keyboard": it stores an explicit `off` activator
 * (which drops the helper's Fn registration) and clears the Talk chord.
 *
 * Drives the real card with the Electron host mocked at the runtime-wrapper
 * seam: `is-electron` reports a desktop host, `hotkey` reports Fn support,
 * and `hotkeys` is an in-memory Talk binding. Follows single-file `bun test`
 * isolation.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "asst-test",
}));
mock.module("@/components/speech/use-managed-voice-selection", () => ({
  useManagedVoiceSelection: () => ({
    available: false,
    voices: [],
    currentModel: "",
    selectModel: () => {},
    selecting: false,
  }),
}));
mock.module("@/components/speech/use-stt-language-selection", () => ({
  useSttLanguageSelection: () => ({
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
mock.module("@/runtime/hotkey", () => ({
  supportsFnPushToTalk: () => true,
  setFnPushToTalkEnabled: async () => true,
  subscribeToHotkeyEvents: () => () => {},
}));

// In-memory stand-in for the Electron Keyboard Shortcuts bridge, holding just
// the Talk binding the card reads and writes.
const hotkeyWrites: Array<{ key: string; accelerator: string | null }> = [];
let talkAccelerator = "";
mock.module("@/runtime/hotkeys", () => ({
  getHotkeys: async () => [
    {
      key: "toggleVoice",
      label: "Talk",
      scope: "global",
      defaultAccelerator: "",
      override: talkAccelerator || null,
      accelerator: talkAccelerator,
      rebindable: true,
    },
  ],
  setHotkey: async (key: string, accelerator: string | null) => {
    hotkeyWrites.push({ key, accelerator });
    if (key === "toggleVoice") {
      talkAccelerator = accelerator ?? "";
    }
  },
  onHotkeysChange: () => () => {},
}));

import { VoiceSections } from "@/domains/settings/pages/voice-page";

function renderPage() {
  return render(
    <MemoryRouter>
      <VoiceSections />
    </MemoryRouter>,
  );
}

function storedBinding() {
  return JSON.parse(
    localStorage.getItem("vellum:voice:voiceModeActivation") ?? "null",
  );
}

beforeEach(() => {
  localStorage.clear();
  hotkeyWrites.length = 0;
  talkAccelerator = "";
});

describe("VoiceSections voice mode shortcut on the desktop host", () => {
  test("offers Fn, a custom chord, and Off", () => {
    renderPage();

    expect(screen.getByRole("button", { name: /Fn/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Custom" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Off" })).toBeTruthy();
  });

  test("choosing Off stores an explicit off and clears the Talk chord", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Off" }));

    expect(storedBinding()).toEqual({ kind: "off" });
    await waitFor(() =>
      expect(hotkeyWrites).toContainEqual({
        key: "toggleVoice",
        accelerator: "",
      }),
    );
  });

  test("choosing Fn after Off restores the Fn binding", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Off" }));
    fireEvent.click(screen.getByRole("button", { name: /Fn/ }));

    expect(storedBinding()).toEqual({
      kind: "modifierOnly",
      modifiers: ["function"],
    });
    await waitFor(() =>
      expect(
        hotkeyWrites.filter((write) => write.key === "toggleVoice"),
      ).toHaveLength(2),
    );
  });
});
