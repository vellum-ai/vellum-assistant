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

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

// The listening-language card reads daemon config through React Query too.
// Hoisted with the mocks above (a mid-file `mock.module` does not re-link on
// CI's bun), so its shape is swapped through this mutable seed instead.
const languageSelection = {
  available: false,
  currentCode: "multi",
  configuredProviderId: "deepgram",
  selectLanguage: () => {},
  selecting: false,
};
mock.module("@/components/speech/use-stt-language-selection", () => ({
  useSttLanguageSelection: () => languageSelection,
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
  languageSelection.available = false;
  languageSelection.currentCode = "multi";
  languageSelection.configuredProviderId = "deepgram";
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

describe("VoiceSections listening language", () => {
  test("renders nothing when the provider is not language-selectable", () => {
    // Gemini and Whisper detect natively, and old daemons omit the
    // capability: showing a control whose value the daemon ignores is worse
    // than showing none.
    renderPage();

    expect(screen.queryByText("Listening language")).toBeNull();
  });

  test("shows the current language in the Input section when selectable", () => {
    languageSelection.available = true;
    languageSelection.currentCode = "multi";

    renderPage();

    expect(screen.getByText("Listening language")).toBeTruthy();
    // Multilingual is a real selection now, not a sentinel standing in for
    // one, so the card names it plainly.
    expect(screen.getByText("Multilingual")).toBeTruthy();
  });

  test("names a deliberate pin rather than the default", () => {
    languageSelection.available = true;
    languageSelection.currentCode = "ta";

    renderPage();

    expect(screen.getByText("Tamil (தமிழ்)")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Microphone picker
// ---------------------------------------------------------------------------

/**
 * Driven with `fireEvent`, matching every other picker test in this repo.
 * That reaches `Select`'s `onChange` here: neutering the callback in
 * `select.tsx` fails "choosing System Default clears the saved device",
 * which is the check worth repeating if these ever start passing suspiciously
 * easily.
 */
describe("VoiceSections microphone picker", () => {
  const MICS: Partial<MediaDeviceInfo>[] = [
    { deviceId: "mic-a", kind: "audioinput", label: "Built-in Mic" },
    { deviceId: "mic-b", kind: "audioinput", label: "USB Mic" },
  ];

  function stubDevices(devices: Partial<MediaDeviceInfo>[]) {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => devices as MediaDeviceInfo[],
        addEventListener: () => {},
        removeEventListener: () => {},
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => {} }],
        }),
      },
    });
  }

  function micTrigger(): HTMLElement {
    // By aria-label, not by text: the page renders several pickers, and
    // matching on rendered text picks whichever one happens to contain the
    // string, which silently passes assertions against the wrong control.
    const el = document.querySelector<HTMLElement>(
      'button[role="combobox"][aria-label="Microphone"]',
    );
    if (!el) {
      throw new Error("expected the microphone trigger");
    }
    return el;
  }

  function optionLabels(): string[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((o) => o.textContent?.trim() ?? "");
  }

  test("System Default is offered", async () => {
    // It carries the stored empty-string value, which Radix reserves. Passing
    // that straight through drops the row and leaves no way to choose it.
    stubDevices(MICS);
    renderPage();
    await waitFor(() => expect(micTrigger()).toBeTruthy());

    fireEvent.click(micTrigger());
    await waitFor(() => expect(optionLabels()).toContain("Built-in Mic"));
    expect(optionLabels()).toContain("System Default");
  });

  test("choosing System Default clears the saved device", async () => {
    localStorage.setItem("vellum:voice:inputDeviceId", "mic-b");
    stubDevices(MICS);
    renderPage();
    await waitFor(() => expect(micTrigger().textContent).toContain("USB Mic"));

    fireEvent.click(micTrigger());
    const systemDefault = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((o) => o.textContent?.trim() === "System Default");
    fireEvent.click(systemDefault!);

    expect(localStorage.getItem("vellum:voice:inputDeviceId")).toBe(null);
  });

  test("a saved device is not called disconnected before permission is granted", async () => {
    // Browsers redact ids and labels until mic access is granted, so the
    // enumerated list is empty for a reason that says nothing about whether
    // the saved device is plugged in. Claiming it is disconnected there tells
    // the user their working microphone is missing.
    localStorage.setItem("vellum:voice:inputDeviceId", "mic-b");
    stubDevices([
      { deviceId: "", kind: "audioinput", label: "" },
      { deviceId: "", kind: "audioinput", label: "" },
    ]);
    renderPage();

    await waitFor(() =>
      expect(micTrigger().textContent).toContain("Saved microphone"),
    );
    expect(micTrigger().textContent).not.toContain("not connected");
  });

  test("a saved device that is unplugged stays on the trigger", async () => {
    // Showing System Default here would claim a preference the user does not
    // have, and would make choosing System Default a no-op that cannot clear
    // it. Capture already falls back, so the saved value is kept.
    localStorage.setItem("vellum:voice:inputDeviceId", "mic-gone");
    stubDevices(MICS);
    renderPage();

    await waitFor(() =>
      expect(micTrigger().textContent).toContain("not connected"),
    );
    expect(localStorage.getItem("vellum:voice:inputDeviceId")).toBe("mic-gone");
  });
});
