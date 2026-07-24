import { type ReactNode } from "react";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

// The voice picker has its own tests; here it stays collapsed (unavailable) so
// the menu renders without the daemon query graph / a QueryClient. Mutable so a
// test can put the assistant on a bring-your-own provider.
let voiceSelection = {
  available: false,
  isByok: false,
  voices: [] as unknown[],
  currentModel: "",
  defaultModel: "",
  selectModel: () => {},
  selecting: false,
};
mock.module("@/components/speech/use-managed-voice-selection", () => ({
  useManagedVoiceSelection: () => voiceSelection,
}));

// The BYO row links to Models & Services; a plain anchor renders it without a
// Router.
mock.module("react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={typeof to === "string" ? to : "#"}>{children}</a>
  ),
}));

const { VoiceRoomSettingsMenu } = await import("./voice-room-settings-menu");

beforeEach(() => {
  voiceSelection = { ...voiceSelection, available: false, isByok: false };
  useVoicePrefsStore.setState({
    showUserTranscript: false,
    showAssistantTranscript: false,
  });
});

afterEach(() => cleanup());

/** Render the menu and open the gear popover. */
function openMenu() {
  render(<VoiceRoomSettingsMenu triggerClassName="ctrl" assistantId="asst_test" />);
  fireEvent.click(screen.getByRole("button", { name: "Voice settings" }));
}

describe("VoiceRoomSettingsMenu", () => {
  test("captions toggle flips both transcript prefs together", () => {
    openMenu();
    fireEvent.click(screen.getByLabelText("Show captions"));
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(true);
    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(true);
  });

  test("captions toggle turns both off when already on", () => {
    useVoicePrefsStore.setState({ showAssistantTranscript: true });
    openMenu();
    fireEvent.click(screen.getByLabelText("Show captions"));
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(false);
    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(false);
  });

  test("captions row keeps its label beside the icon", () => {
    openMenu();
    expect(screen.getByText("Captions")).toBeTruthy();
    expect(screen.getByLabelText("Show captions")).toBeTruthy();
  });

  test("no pause-before-reply control (removed with the two-tier model)", () => {
    openMenu();
    expect(screen.queryByLabelText("Pause before reply")).toBeNull();
  });

  test("a bring-your-own provider gets a disabled Voice row and a Settings link", () => {
    voiceSelection = { ...voiceSelection, available: false, isByok: true };
    openMenu();
    // Disabled rather than hidden, so the option is visibly unavailable rather
    // than missing, with the one place it can be changed right under it.
    const row = screen.getByText("Your API key").closest("button");
    expect(row?.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("link", { name: "Change voice in Settings" }),
    ).toBeTruthy();
  });

  test("collapses the Voice row entirely while availability is unknown", () => {
    // Not managed AND not confirmed BYO (config still loading) — showing the
    // BYO row here would flash a wrong state on every open.
    openMenu();
    expect(screen.queryByText("Voice")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
