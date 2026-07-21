/**
 * Tests for `VoiceFirstRunCard`.
 *
 * The card is exercised in isolation: `onStart` is a spy, and the assistant
 * avatar / BYOK-form dependencies are stubbed so the card renders without the
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
 *   - the bring-your-own-key detour is a VIEW of this one modal, not a modal
 *     stacked on it, and returns to the intro.
 */
import { useEffect } from "react";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render } from "@testing-library/react";

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

// The BYOK forms own the daemon config/credential graph and are covered by the
// settings-page tests. Here they stand in as save handles: each publishes a
// dirty flag and a `save` the card's single footer button has to drive, which
// is what's under test.
type StubFormProps = {
  hideSaveButton?: boolean;
  onSaveStateChange?: (handle: {
    hasChanges: boolean;
    saving: boolean;
    save: () => Promise<boolean>;
  }) => void;
};

/** Per-service stub behavior, set by each test before render. */
const formState = {
  stt: { dirty: false, saveOk: true },
  tts: { dirty: false, saveOk: true },
};
const saveCalls: string[] = [];

function makeStubForm(kind: "stt" | "tts") {
  return function StubForm({ onSaveStateChange }: StubFormProps) {
    const { dirty, saveOk } = formState[kind];
    // Mirrors the real form: republish whenever the state it reports changes.
    useEffect(() => {
      onSaveStateChange?.({
        hasChanges: dirty,
        saving: false,
        save: async () => {
          saveCalls.push(kind);
          return saveOk;
        },
      });
    }, [onSaveStateChange, dirty, saveOk]);
    return <div data-testid={`${kind}-form`} />;
  };
}

mock.module("@/components/speech/stt-provider-form", () => ({
  SttProviderForm: makeStubForm("stt"),
}));
mock.module("@/components/speech/tts-provider-form", () => ({
  TtsProviderForm: makeStubForm("tts"),
}));

import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

// Imported after the mocks so the card resolves against the stubs.
const { VoiceFirstRunCard } = await import(
  "@/domains/chat/voice/voice-room/voice-first-run-card"
);

const BYOK_LINK = "I have my own STT/TTS API key";

afterEach(cleanup);
beforeEach(() => {
  // Fresh first run, both transcripts off — the real first-entry state.
  useVoicePrefsStore.setState({
    showUserTranscript: false,
    showAssistantTranscript: false,
    firstRunSeen: false,
  });
  formState.stt = { dirty: false, saveOk: true };
  formState.tts = { dirty: false, saveOk: true };
  saveCalls.length = 0;
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

  describe("bring-your-own-key view", () => {
    test("the link opens the key view in place — one dialog, no stack", () => {
      const { getByText, queryByText, baseElement } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );

      fireEvent.click(getByText(BYOK_LINK));

      expect(getByText("Use your own API keys")).toBeTruthy();
      // Section copy matches Settings → Services so the two read as one.
      expect(getByText("Text-to-Speech")).toBeTruthy();
      expect(getByText("Configure how your assistant speaks")).toBeTruthy();
      expect(getByText("Speech-to-Text")).toBeTruthy();
      expect(
        getByText("Configure how your assistant transcribes speech"),
      ).toBeTruthy();
      // The intro's forward action is gone — this is a view swap, not an
      // overlay on top of the intro.
      expect(queryByText("Start talking")).toBeNull();
      expect(baseElement.querySelectorAll('[role="dialog"]').length).toBe(1);
    });

    test("back returns to the intro without starting or consuming the first run", () => {
      const onStart = mock(() => {});
      const { getByText, getByLabelText } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={onStart} />,
      );

      fireEvent.click(getByText(BYOK_LINK));
      fireEvent.click(getByLabelText("Back"));

      expect(getByText("Start talking")).toBeTruthy();
      expect(onStart).not.toHaveBeenCalled();
      expect(useVoicePrefsStore.getState().firstRunSeen).toBe(false);
    });

    test("one Save commits both forms and lands back on Start talking", async () => {
      formState.stt = { dirty: true, saveOk: true };
      formState.tts = { dirty: true, saveOk: true };
      const { getByText } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );

      fireEvent.click(getByText(BYOK_LINK));
      await act(async () => {
        fireEvent.click(getByText("Save"));
      });

      expect(saveCalls.sort()).toEqual(["stt", "tts"]);
      expect(getByText("Start talking")).toBeTruthy();
    });

    test("Save writes only the forms that changed", async () => {
      formState.tts = { dirty: true, saveOk: true };
      const { getByText } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );

      fireEvent.click(getByText(BYOK_LINK));
      await act(async () => {
        fireEvent.click(getByText("Save"));
      });

      // Entering a TTS key must not re-write the untouched STT service.
      expect(saveCalls).toEqual(["tts"]);
    });

    test("Save stays disabled until something changes", () => {
      const { getByText } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );

      fireEvent.click(getByText(BYOK_LINK));
      expect((getByText("Save") as HTMLButtonElement).disabled).toBe(true);
    });

    test("a failed save keeps the user on the key view", async () => {
      // The typed key has to stay on screen with its failure toast, not
      // vanish behind the intro.
      formState.tts = { dirty: true, saveOk: false };
      const { getByText, queryByText } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );

      fireEvent.click(getByText(BYOK_LINK));
      await act(async () => {
        fireEvent.click(getByText("Save"));
      });

      expect(getByText("Use your own API keys")).toBeTruthy();
      expect(queryByText("Start talking")).toBeNull();
    });

    test("the link is reachable under the iOS lock too", () => {
      // The lock removes cancels, not in-modal navigation — a locked card
      // still has to let a BYOK user configure before the mic prompt.
      const { getByText, getByLabelText } = render(
        <VoiceFirstRunCard
          assistantId="asst_test"
          onStart={() => {}}
          nonDismissible
        />,
      );

      fireEvent.click(getByText(BYOK_LINK));
      expect(getByText("Use your own API keys")).toBeTruthy();
      fireEvent.click(getByLabelText("Back"));
      expect(getByText("Start talking")).toBeTruthy();
    });
  });
});
