import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { makeControlsSpies } from "@/domains/chat/voice/live-voice/live-voice-fakes.test-helper";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

import { VoiceRoomSettingsMenu } from "./voice-room-settings-menu";

const controls = makeControlsSpies();

beforeEach(() => {
  useVoicePrefsStore.setState({
    showUserTranscript: false,
    showAssistantTranscript: false,
    pauseBeforeReplyMs: null,
    interruptSensitivity: null,
  });
  useLiveVoiceStore.getState().reset();
  // A live session with registered controls, so the live-apply path is exercised.
  useLiveVoiceStore.getState().setControls(controls);
  controls.updateConfig.mockClear();
});

afterEach(() => cleanup());

/** Render the menu and open the gear popover. */
function openMenu() {
  render(<VoiceRoomSettingsMenu triggerClassName="ctrl" />);
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

  test("moving the pause slider persists the value and live-applies it to the session", () => {
    openMenu();
    // Default resting value is 1.2s; one step right → 1.3s (1300 ms).
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });

    expect(useVoicePrefsStore.getState().pauseBeforeReplyMs).toBe(1300);
    expect(controls.updateConfig).toHaveBeenCalledWith({
      silenceThresholdMs: 1300,
    });
  });
});
