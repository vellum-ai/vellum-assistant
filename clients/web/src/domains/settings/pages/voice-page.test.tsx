/**
 * Captions and turn-taking cards on the Voice settings page.
 *
 * Both caption toggles default OFF on first render (the persisted voice-prefs
 * store starts empty), and flipping each switch writes the new value straight
 * through to `useVoicePrefsStore`. The turn-taking dials advertise their unset
 * state — the settings they'd otherwise misreport belong to daemon config until
 * the user touches them.
 *
 * Drives the real `VoiceSections` and the real `voice-prefs-store`; only
 * `localStorage` is stubbed so the persist middleware has somewhere to write.
 * Follows single-file `bun test` isolation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The voice-picker card reads the active assistant id (throws outside the
// gate) and the managed-voice catalog. Neither is under test here; seed a
// fixed id and report no managed catalog so the card takes its inert
// BYO branch.
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

import { VoiceSections } from "@/domains/settings/pages/voice-page";
import {
  DEFAULT_PAUSE_BEFORE_REPLY_MS,
  useVoicePrefsStore,
} from "@/stores/voice-prefs-store";

function renderPage() {
  return render(
    <MemoryRouter>
      <VoiceSections />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useVoicePrefsStore.setState({
    showUserTranscript: false,
    showAssistantTranscript: false,
    firstRunSeen: false,
    pauseBeforeReplyMs: null,
    interruptSensitivity: null,
  });
});

afterEach(() => {
  cleanup();
});

describe("VoiceSections turn-taking defaults", () => {
  test("both dials read as Default until the user sets one", () => {
    renderPage();

    expect(screen.getAllByText("Default")).toHaveLength(2);
    // Nothing to reset while both are unset.
    expect(screen.queryByRole("button", { name: "Reset to defaults" })).toBe(
      null,
    );
  });

  test("setting a sensitivity clears only that row's Default badge", () => {
    renderPage();

    fireEvent.click(screen.getByRole("radio", { name: "Low" }));

    expect(useVoicePrefsStore.getState().interruptSensitivity).toBe("low");
    // The pause slider is still unset, so exactly one badge remains.
    expect(screen.getAllByText("Default")).toHaveLength(1);
  });

  test("Reset returns both dials to daemon-governed defaults", () => {
    useVoicePrefsStore.setState({
      pauseBeforeReplyMs: DEFAULT_PAUSE_BEFORE_REPLY_MS,
      interruptSensitivity: "high",
    });
    renderPage();

    expect(screen.queryByText("Default")).toBe(null);

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));

    const state = useVoicePrefsStore.getState();
    expect(state.pauseBeforeReplyMs).toBe(null);
    expect(state.interruptSensitivity).toBe(null);
  });
});

describe("VoiceSections Models & Services pointer", () => {
  test("stays hidden while the voice card carries the same pointer", () => {
    // The mocked selection reports no managed catalog, so the card renders its
    // own "set its voice on Models & Services" copy — the banner beneath it
    // would just repeat that sentence.
    renderPage();

    expect(screen.queryByText(/own API key for STT or TTS/)).toBeNull();
  });
});

describe("VoiceSections caption toggles", () => {
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
