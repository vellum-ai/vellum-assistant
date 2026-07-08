/**
 * Tests for the shared `VoiceTranscriptToggles`.
 *
 * This is the single component both the Voice settings page and the voice
 * first-run card render, so its contract is load-bearing for both surfaces:
 * two toggles bound to the shared `voice-prefs` store, both default OFF, each
 * writing straight through to the store. The `showDescription` /
 * `showRecommendedBadge` props select the per-surface affordance.
 *
 * Follows single-file `bun test` isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { VoiceTranscriptToggles } from "@/components/voice-transcript-toggles";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

beforeEach(() => {
  localStorage.clear();
  useVoicePrefsStore.setState({
    showUserTranscript: false,
    showAssistantTranscript: false,
    firstRunSeen: false,
  });
});

afterEach(cleanup);

describe("VoiceTranscriptToggles", () => {
  test("renders both toggles, off by default, and writes through to the store", () => {
    render(<VoiceTranscriptToggles />);

    const userToggle = screen.getByRole("switch", {
      name: "Show the words you say",
    });
    const assistantToggle = screen.getByRole("switch", {
      name: "Show the words the assistant says",
    });

    expect(userToggle.getAttribute("aria-checked")).toBe("false");
    expect(assistantToggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(userToggle);
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(true);
    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(false);

    fireEvent.click(assistantToggle);
    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(true);
  });

  test("showDescription renders the per-toggle description lines", () => {
    render(<VoiceTranscriptToggles showDescription />);
    expect(screen.getByText("Live transcription while you speak.")).toBeTruthy();
    expect(
      screen.getByText("Text alongside the spoken response."),
    ).toBeTruthy();
  });

  test("showRecommendedBadge renders a 'Recommended off' pill per toggle", () => {
    render(<VoiceTranscriptToggles showRecommendedBadge />);
    expect(screen.getAllByText("Recommended off")).toHaveLength(2);
  });
});
