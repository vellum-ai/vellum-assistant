/**
 * Tests for `VoiceFirstRunCard`.
 *
 * The card is exercised in isolation: `onStart` is a spy, and the real
 * persisted `voice-prefs` store backs the toggles (reset between tests). The
 * assistant-avatar hook is stubbed so the card renders without the React Query
 * graph — the avatar is chrome, not behavior.
 *
 * Load-bearing behavior:
 *   - the card renders on first run and does NOT start on its own,
 *   - the toggles mutate the shared voice-prefs store (both default OFF),
 *   - "Start" invokes the caller's `onStart`; wiring that `onStart` to
 *     `markFirstRunSeen` (as the composer does) consumes the first run so a
 *     second entry would skip the card.
 */
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

import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

// Imported after the mock so the card resolves against the stubbed hook.
const { VoiceFirstRunCard } = await import(
  "@/domains/chat/voice/voice-room/voice-first-run-card"
);

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
    const { getByText, getByLabelText } = render(
      <VoiceFirstRunCard assistantId="asst_test" onStart={onStart} />,
    );

    // Title + both toggles are present, and nothing has started yet.
    expect(getByText("Voice mode")).toBeTruthy();
    expect(getByLabelText("Show the words you say")).toBeTruthy();
    expect(getByLabelText("Show the words the assistant says")).toBeTruthy();
    expect(getByText("Start")).toBeTruthy();
    expect(onStart).not.toHaveBeenCalled();
  });

  test("toggles are OFF by default and flip the shared voice-prefs store", () => {
    const { getByLabelText } = render(
      <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
    );

    // Defaults OFF.
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(false);
    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(false);

    // Flipping each toggle writes through to the same store the settings
    // page reads.
    fireEvent.click(getByLabelText("Show the words you say"));
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(true);

    fireEvent.click(getByLabelText("Show the words the assistant says"));
    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(true);
  });

  test("Start invokes onStart", () => {
    const onStart = mock(() => {});
    const { getByText } = render(
      <VoiceFirstRunCard assistantId="asst_test" onStart={onStart} />,
    );

    fireEvent.click(getByText("Start"));
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
    fireEvent.click(getByText("Start"));
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(true);
  });
});
