/**
 * Tests for `VoiceFirstRunCard`.
 *
 * The card is exercised in isolation: `onStart` is a spy, and the assistant
 * avatar / voice-list dependencies are stubbed so the card renders without the
 * React Query graph — they are chrome around the card's own behavior, and each
 * has its own tests.
 *
 * Load-bearing behavior:
 *   - the card renders on first run and does NOT start on its own,
 *   - it carries no settings quiz — captions, voice, and the rest are
 *     in-session and in Settings, not front-loaded here,
 *   - "Start" invokes the caller's `onStart`; wiring that `onStart` to
 *     `markFirstRunSeen` (as the composer does) consumes the first run so a
 *     second entry would skip the card,
 *   - the voice-settings detour is a VIEW of this one modal, not a modal
 *     stacked on it, and returns to the intro.
 */
import { type ReactNode } from "react";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

// Stub the avatar hook so the card renders without the assistant-avatar React
// Query graph — irrelevant to the card's preference behavior.
mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: null,
    traits: null,
    customImageUrl: null,
    isLoading: false,
    invalidate: () => {},
  }),
}));

// The voice list owns the daemon config graph and is covered by its own tests.
// Here it stands in as a marker so the settings view renders without the React
// Query graph — the card's own behavior (view swap, back, lock) is what's under
// test, not the picker.
mock.module("@/components/speech/voice-list", () => ({
  VoiceList: () => <div data-testid="voice-list" />,
}));

// The Voices view reads managed-voice availability (for the credits subtitle)
// off the daemon config graph; stub it so the card renders without React Query.
mock.module("@/components/speech/use-managed-voice-selection", () => ({
  useManagedVoiceSelection: () => ({
    available: true,
    voices: [],
    currentModel: "",
    defaultModel: "",
    selectModel: () => {},
    selecting: false,
  }),
}));

// The settings view links to Models & Services; give it a plain anchor so the
// card renders without a Router.
mock.module("react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={typeof to === "string" ? to : "#"}>{children}</a>
  ),
}));

import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

// Imported after the mocks so the card resolves against the stubs.
const { VoiceFirstRunCard } = await import(
  "@/domains/chat/voice/voice-room/voice-first-run-card"
);

const SETTINGS_LINK = "Voice settings";

/**
 * The dialog's current title. Read the heading specifically rather than matching
 * text anywhere — the intro's "Voice settings" link would otherwise satisfy a
 * loose text match for the settings-view assertions.
 */
function dialogTitle(): string {
  return document.querySelector('[data-slot="modal-title"]')?.textContent ?? "";
}

afterEach(cleanup);
beforeEach(() => {
  // Fresh first run, both transcripts off — the real first-entry state.
  useVoicePrefsStore.setState({
    showUserTranscript: false,
    showAssistantTranscript: false,
    firstRunSeen: false,
  });
});

describe("VoiceFirstRunCard", () => {
  test("renders the card and does not start on its own", () => {
    const onStart = mock(() => {});
    const { getByText } = render(
      <VoiceFirstRunCard assistantId="asst_test" onStart={onStart} />,
    );

    expect(getByText("Voice mode")).toBeTruthy();
    expect(getByText("Start talking")).toBeTruthy();
    expect(onStart).not.toHaveBeenCalled();
  });

  test("carries no settings quiz — no transcript toggles, no voice row, prefs untouched", () => {
    const { queryByLabelText, queryByText } = render(
      <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
    );

    // Captions and voice are in-session settings (the voice room's gear), not
    // choices to front-load here, and the card never writes the prefs store on
    // its own.
    expect(queryByLabelText("Show the words you say")).toBeNull();
    expect(queryByLabelText("Show the words the assistant says")).toBeNull();
    expect(queryByText("Voice")).toBeNull();
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(false);
    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(false);
  });

  test("Start invokes onStart", () => {
    const onStart = mock(() => {});
    const { getByText } = render(
      <VoiceFirstRunCard assistantId="asst_test" onStart={onStart} />,
    );

    fireEvent.click(getByText("Start talking"));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test("Start wired to markFirstRunSeen (as the composer does) consumes the first run", () => {
    // Mirror the composer's onStart handler: committing marks the first run
    // seen so a second entry would skip the card entirely.
    const onStart = mock(() => useVoicePrefsStore.getState().markFirstRunSeen());
    const { getByText } = render(
      <VoiceFirstRunCard assistantId="asst_test" onStart={onStart} />,
    );

    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(false);
    fireEvent.click(getByText("Start talking"));
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(true);
  });

  test("dismissible by default (web): renders the ✕ close affordance", () => {
    const { getByLabelText } = render(
      <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
    );
    expect(getByLabelText("Close")).toBeTruthy();
  });

  test("nonDismissible (iOS lock): no ✕, only Start talking leads forward", () => {
    // The lock strips the close affordance so the pre-permission card leads
    // straight to the mic alert (CAPACITOR.md § OS permission requests); there
    // is intentionally no card-level cancel.
    const { queryByLabelText, getByText } = render(
      <VoiceFirstRunCard
        assistantId="asst_test"
        onStart={() => {}}
        nonDismissible
      />,
    );
    expect(queryByLabelText("Close")).toBeNull();
    expect(getByText("Start talking")).toBeTruthy();
  });

  describe("voice settings view", () => {
    test("the link opens the settings view in place — one dialog, no stack", () => {
      const { getByText, getByTestId, queryByText, baseElement } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );

      fireEvent.click(getByText(SETTINGS_LINK));

      expect(dialogTitle()).toBe("Voices");
      // The view is just the voice picker plus a pointer to Models & Services,
      // where advanced/BYO provider and API-key config lives.
      expect(getByTestId("voice-list")).toBeTruthy();
      expect(getByText("Models & Services")).toBeTruthy();
      // The voice hot-applies, so there's no Save. "Start talking" moves into
      // this view so a pick flows straight in, and it's a view swap, not an
      // overlay — one dialog.
      expect(queryByText("Save")).toBeNull();
      expect(getByText("Start talking")).toBeTruthy();
      expect(baseElement.querySelectorAll('[role="dialog"]').length).toBe(1);
    });

    test("back returns to the intro without starting or consuming the first run", () => {
      const onStart = mock(() => {});
      const { getByText, getByLabelText } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={onStart} />,
      );

      fireEvent.click(getByText(SETTINGS_LINK));
      fireEvent.click(getByLabelText("Back"));

      expect(getByText("Start talking")).toBeTruthy();
      expect(onStart).not.toHaveBeenCalled();
      expect(useVoicePrefsStore.getState().firstRunSeen).toBe(false);
    });

    test("the link is reachable under the iOS lock too", () => {
      // The lock removes cancels, not in-modal navigation — a locked card
      // still has to let a user reach voice settings before the mic prompt.
      const { getByText, getByLabelText } = render(
        <VoiceFirstRunCard
          assistantId="asst_test"
          onStart={() => {}}
          nonDismissible
        />,
      );

      fireEvent.click(getByText(SETTINGS_LINK));
      expect(dialogTitle()).toBe("Voices");
      fireEvent.click(getByLabelText("Back"));
      expect(getByText("Start talking")).toBeTruthy();
    });
  });
});
