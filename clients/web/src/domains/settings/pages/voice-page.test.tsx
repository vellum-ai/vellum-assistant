/**
 * Transcription card on the Voice settings page.
 *
 * Both transcript toggles default OFF on first render (the persisted
 * voice-prefs store starts empty), and flipping each switch writes the new
 * value straight through to `useVoicePrefsStore`.
 *
 * Drives the real `VoicePage` and the real `voice-prefs-store`; only
 * `localStorage` is stubbed so the persist middleware has somewhere to write.
 * Follows single-file `bun test` isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { VoicePage } from "@/domains/settings/pages/voice-page";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

function renderPage() {
  return render(
    <MemoryRouter>
      <VoicePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useVoicePrefsStore.setState({
    showUserTranscript: false,
    showAssistantTranscript: false,
    firstRunSeen: false,
  });
});

afterEach(() => {
  cleanup();
});

describe("VoicePage transcription toggles", () => {
  test("both transcript toggles default to off on first render", () => {
    renderPage();

    const userToggle = screen.getByRole("switch", {
      name: "Show the words you say",
    });
    const assistantToggle = screen.getByRole("switch", {
      name: "Show the words the assistant says",
    });

    expect(userToggle.getAttribute("aria-checked")).toBe("false");
    expect(assistantToggle.getAttribute("aria-checked")).toBe("false");
  });

  test("toggling the user transcript updates the store", () => {
    renderPage();

    fireEvent.click(
      screen.getByRole("switch", { name: "Show the words you say" }),
    );

    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(true);
    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(false);
  });

  test("toggling the assistant transcript updates the store", () => {
    renderPage();

    fireEvent.click(
      screen.getByRole("switch", {
        name: "Show the words the assistant says",
      }),
    );

    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(true);
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(false);
  });
});
