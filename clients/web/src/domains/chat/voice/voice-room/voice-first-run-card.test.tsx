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
 *     stacked on it, and returns to the intro,
 *   - the listening-language row renders only on locale evidence plus daemon
 *     capability, never writes without an explicit pick, and holds Start
 *     while a pick's write is in flight.
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

// The listening-language row reads availability and the current code off the
// daemon config graph through this hook; a mutable stub keeps the card free
// of React Query and lets each test shape daemon capability independently of
// the locale evidence it stubs on `navigator.language`.
const STT_LANGUAGE_SELECTION_DEFAULTS = {
  available: false,
  currentCode: "",
  configuredProviderId: "vellum",
  selectLanguage: (_code: string) => {},
  selecting: false,
};
let sttLanguageSelection = { ...STT_LANGUAGE_SELECTION_DEFAULTS };
mock.module("@/components/speech/use-stt-language-selection", () => ({
  useSttLanguageSelection: () => sttLanguageSelection,
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
const { VoiceFirstRunCard } =
  await import("@/domains/chat/voice/voice-room/voice-first-run-card");

const SETTINGS_LINK = "Voice settings";

/**
 * The dialog's current title. Read the heading specifically rather than matching
 * text anywhere — the intro's "Voice settings" link would otherwise satisfy a
 * loose text match for the settings-view assertions.
 */
function dialogTitle(): string {
  return document.querySelector('[data-slot="modal-title"]')?.textContent ?? "";
}

/**
 * Stub the browser locale the card reads for its language suggestion. The
 * original descriptor (own or absent, with the prototype getter beneath) is
 * restored after every test so locale evidence never leaks between them.
 */
const originalLanguageDescriptor = Object.getOwnPropertyDescriptor(
  window.navigator,
  "language",
);
function stubLocale(language: string): void {
  Object.defineProperty(window.navigator, "language", {
    value: language,
    configurable: true,
  });
}
function restoreLocale(): void {
  if (originalLanguageDescriptor) {
    Object.defineProperty(
      window.navigator,
      "language",
      originalLanguageDescriptor,
    );
  } else {
    delete (window.navigator as { language?: string }).language;
  }
}

afterEach(() => {
  cleanup();
  restoreLocale();
});
beforeEach(() => {
  // Fresh first run, both transcripts off — the real first-entry state.
  useVoicePrefsStore.setState({
    showUserTranscript: false,
    showAssistantTranscript: false,
    firstRunSeen: false,
  });
  sttLanguageSelection = { ...STT_LANGUAGE_SELECTION_DEFAULTS };
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
    const onStart = mock(() =>
      useVoicePrefsStore.getState().markFirstRunSeen(),
    );
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

  describe("listening language row", () => {
    const ROW_LABEL = "Listening language";

    /**
     * Open the language sub-view through the row and return the picker's
     * option rows, in render order (Featured first, then A-Z).
     */
    function languageOptions(getByLabelText: (label: string) => HTMLElement) {
      fireEvent.click(getByLabelText(ROW_LABEL));
      return Array.from(
        document.querySelectorAll<HTMLElement>('[role="option"]'),
      );
    }

    test("an English locale sees no row even when the provider is selectable", () => {
      stubLocale("en-US");
      sttLanguageSelection = { ...sttLanguageSelection, available: true };
      const { queryByLabelText } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );
      // No locale evidence means no row: the card stays exactly the card.
      expect(queryByLabelText(ROW_LABEL)).toBeNull();
    });

    test("locale evidence without daemon support sees no row", () => {
      stubLocale("hi-IN");
      // `available` stays false: an auto-detecting provider or an old daemon.
      const { queryByLabelText } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );
      expect(queryByLabelText(ROW_LABEL)).toBeNull();
    });

    test("locale evidence plus a selectable provider shows the row with Multilingual suggested", () => {
      stubLocale("hi-IN");
      sttLanguageSelection = { ...sttLanguageSelection, available: true };
      const { getByLabelText } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );

      const options = languageOptions(getByLabelText);
      // The Featured group pins the current (default) value first with the
      // annotated suggestion beside it; the rest of the catalog follows A-Z.
      expect(options[0]?.textContent).toContain("English (default)");
      expect(options[1]?.textContent).toContain("Multilingual");
      expect(options[1]?.textContent).toContain("Suggested");
    });

    test("under xai a multi-roster locale falls back to the monolingual suggestion", () => {
      // xai's option set omits Multilingual, so the suggestion degrades to
      // the Hindi pin (which every language-selectable provider offers)
      // instead of vanishing or naming a row the picker withholds.
      stubLocale("hi-IN");
      sttLanguageSelection = {
        ...sttLanguageSelection,
        available: true,
        configuredProviderId: "xai",
      };
      const { getByLabelText } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );

      const options = languageOptions(getByLabelText);
      expect(options[0]?.textContent).toContain("Auto-detect (default)");
      expect(options[1]?.textContent).toContain("Hindi");
      expect(options[1]?.textContent).toContain("Suggested");
      expect(options.some((o) => o.textContent?.includes("Multilingual"))).toBe(
        false,
      );
    });

    test("an extended-roster locale under xai sees no row: nothing valid to suggest", () => {
      // xai never offers "ta", so a row would render with no suggestion and
      // no matching language; the provider-aware suggestion hides it.
      stubLocale("ta-IN");
      sttLanguageSelection = {
        ...sttLanguageSelection,
        available: true,
        configuredProviderId: "xai",
      };
      const { queryByLabelText } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );
      expect(queryByLabelText(ROW_LABEL)).toBeNull();
    });

    test("the row opens the language sub-view in place: one dialog, no stack", () => {
      stubLocale("hi-IN");
      sttLanguageSelection = { ...sttLanguageSelection, available: true };
      const { getByLabelText, baseElement } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );

      fireEvent.click(getByLabelText(ROW_LABEL));
      expect(dialogTitle()).toBe("Listening language");
      expect(baseElement.querySelectorAll('[role="dialog"]').length).toBe(1);
      // The shared picker's search field is the sub-view's first control.
      expect(document.querySelector('input[role="combobox"]')).not.toBeNull();
    });

    test("Escape in the language sub-view returns to the intro, not a dismiss", () => {
      stubLocale("hi-IN");
      sttLanguageSelection = { ...sttLanguageSelection, available: true };
      const onDismiss = mock(() => {});
      const { getByLabelText, getByText } = render(
        <VoiceFirstRunCard
          assistantId="asst_test"
          onStart={() => {}}
          onDismiss={onDismiss}
        />,
      );

      fireEvent.click(getByLabelText(ROW_LABEL));
      expect(dialogTitle()).toBe("Listening language");
      // Dispatch on the picker's search field, the element that holds focus
      // in the sub-view: keying off a queried in-dialog target (the file's
      // selector convention for the search field) keeps the test independent
      // of environment-specific autofocus timing.
      const search = document.querySelector<HTMLInputElement>(
        'input[role="combobox"]',
      );
      expect(search).not.toBeNull();
      // With text in the search field the stakes are highest: Escape must
      // discard at most the query, never the whole card.
      fireEvent.change(search!, { target: { value: "tam" } });
      fireEvent.keyDown(search!, { key: "Escape" });
      // Back on the intro with the card still open and un-consumed.
      expect(getByText("Start talking")).toBeTruthy();
      expect(onDismiss).not.toHaveBeenCalled();
      expect(useVoicePrefsStore.getState().firstRunSeen).toBe(false);
    });

    test("picking Tamil from search calls selectLanguage with its code", () => {
      stubLocale("hi-IN");
      const selectLanguage = mock((_code: string) => {});
      sttLanguageSelection = {
        ...sttLanguageSelection,
        available: true,
        selectLanguage,
      };
      const { getByLabelText, getByText } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );

      fireEvent.click(getByLabelText(ROW_LABEL));
      const search = document.querySelector<HTMLInputElement>(
        'input[role="combobox"]',
      );
      expect(search).not.toBeNull();
      fireEvent.change(search!, { target: { value: "tamil" } });
      const options = Array.from(
        document.querySelectorAll<HTMLElement>('[role="option"]'),
      );
      expect(options).toHaveLength(1);
      fireEvent.click(options[0]!);

      expect(selectLanguage).toHaveBeenCalledTimes(1);
      expect(selectLanguage).toHaveBeenCalledWith("ta");
      // The pick returns to the intro (hot-applies; nothing else to do).
      expect(getByText("Start talking")).toBeTruthy();
    });

    test("a pick writes the language; merely rendering writes nothing", () => {
      stubLocale("hi-IN");
      const selectLanguage = mock((_code: string) => {});
      sttLanguageSelection = {
        ...sttLanguageSelection,
        available: true,
        selectLanguage,
      };
      const { getByLabelText } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );
      // Showing the smart default never auto-writes.
      expect(selectLanguage).not.toHaveBeenCalled();

      const multilingual = languageOptions(getByLabelText).find((o) =>
        o.textContent?.includes("Multilingual"),
      );
      expect(multilingual).toBeTruthy();
      fireEvent.click(multilingual!);

      expect(selectLanguage).toHaveBeenCalledTimes(1);
      expect(selectLanguage).toHaveBeenCalledWith("multi");
    });

    test("Start waits out an in-flight language write", () => {
      stubLocale("hi-IN");
      sttLanguageSelection = {
        ...sttLanguageSelection,
        available: true,
        selecting: true,
      };
      const { getByText } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );
      const start = getByText("Start talking").closest("button");
      expect(start?.disabled).toBe(true);
    });

    test("the settings view's Start also waits out the language write", () => {
      // A language pick on the intro followed by opening Voice settings must
      // not offer a Start that races the config patch.
      stubLocale("hi-IN");
      sttLanguageSelection = {
        ...sttLanguageSelection,
        available: true,
        selecting: true,
      };
      const { getByText } = render(
        <VoiceFirstRunCard assistantId="asst_test" onStart={() => {}} />,
      );
      fireEvent.click(getByText("Voice settings"));
      const start = getByText("Start talking").closest("button");
      expect(start?.disabled).toBe(true);
    });
  });
});
