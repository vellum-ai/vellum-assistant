import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

// The voice picker has its own tests; here it stays collapsed (unavailable) so
// the menu renders without the daemon query graph / a QueryClient.
mock.module("@/components/speech/use-managed-voice-selection", () => ({
  useManagedVoiceSelection: () => ({
    available: false,
    voices: [],
    currentModel: "",
    selectModel: () => {},
    selecting: false,
  }),
}));

import { VoiceRoomSettingsMenu } from "./voice-room-settings-menu";

beforeEach(() => {
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

  test("no pause-before-reply control (removed with the two-tier model)", () => {
    openMenu();
    expect(screen.queryByLabelText("Pause before reply")).toBeNull();
  });
});
