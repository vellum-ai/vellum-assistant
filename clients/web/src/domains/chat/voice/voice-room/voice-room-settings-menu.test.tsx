import { type ReactNode } from "react";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Loaded (real) before the sdk.gen mock below replaces the registry entry, so
// the mock can spread the full export surface and only override `configPatch`.
import * as realDaemonSdk from "@/generated/daemon/sdk.gen";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

// The voice picker has its own tests; here it stays collapsed (unavailable) so
// the menu renders without the daemon query graph / a QueryClient. Mutable so a
// test can put the assistant on a bring-your-own provider.
let voiceSelection = {
  available: false,
  isByok: false,
  voices: [] as unknown[],
  currentModel: "",
  defaultModel: "",
  selectModel: () => {},
  selecting: false,
};
mock.module("@/components/speech/use-managed-voice-selection", () => ({
  useManagedVoiceSelection: () => voiceSelection,
}));

// The daemon config PATCH the serialization tests observe. Each call records
// the language it carries; `deferPatches` holds every call open until a test
// releases it through `patchResolvers`, simulating a slow write.
let patchCalls: Array<{ language: string }> = [];
let patchResolvers: Array<() => void> = [];
let deferPatches = false;
async function recordConfigPatch(options: unknown) {
  const body = (
    options as { body: { services: { stt: { language: string } } } }
  ).body;
  patchCalls.push({ language: body.services.stt.language });
  if (deferPatches) {
    await new Promise<void>((resolve) => patchResolvers.push(resolve));
  }
  return { response: { ok: true } };
}
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...realDaemonSdk,
  configPatch: recordConfigPatch,
}));

// Imported after the sdk.gen mock so its `configPatch` binding links to the
// recording mock above (bun in CI does not re-link already-loaded modules).
const { useSerializedConfigSelection } =
  await import("@/components/speech/use-serialized-config-selection");

// The listening-language selection mock: unavailable by default so the menu
// renders without the daemon query graph. Mutable so tests can offer
// languages and observe picks; `sttLanguageOptionsFor` itself is real. The
// serialization tests flip `serializedSelection` to swap in the REAL
// `useSerializedConfigSelection` write chain (with `configPatch` mocked
// above), so close/reopen write ordering exercises the shipped engine.
let serializedSelection = false;
let languagePicks: string[] = [];
let languageSelection = {
  available: false,
  currentCode: "",
  configuredProviderId: "vellum",
  selectLanguage: (code: string) => languagePicks.push(code),
  selecting: false,
};

const buildTestPatchBody = (code: string) => ({
  services: { stt: { language: code } },
});

/** The mock hook: the static fixture, or the real serialized write chain. */
function useMockSttLanguageSelection() {
  // Called unconditionally so hook order is stable across modes.
  const serialized = useSerializedConfigSelection({
    assistantId: "asst_test",
    configuredValue: "",
    buildPatchBody: buildTestPatchBody,
    failureMessage: "test failure",
  });
  if (!serializedSelection) {
    return languageSelection;
  }
  return {
    available: true,
    currentCode: serialized.currentValue,
    configuredProviderId: "vellum",
    selectLanguage: serialized.select,
    selecting: serialized.selecting,
  };
}
mock.module("@/components/speech/use-stt-language-selection", () => ({
  useSttLanguageSelection: useMockSttLanguageSelection,
}));

// The BYO row links to Models & Services; a plain anchor renders it without a
// Router.
mock.module("react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={typeof to === "string" ? to : "#"}>{children}</a>
  ),
}));

const { VoiceRoomSettingsMenu } = await import("./voice-room-settings-menu");

beforeEach(() => {
  voiceSelection = { ...voiceSelection, available: false, isByok: false };
  serializedSelection = false;
  languagePicks = [];
  languageSelection = {
    ...languageSelection,
    available: false,
    currentCode: "",
  };
  patchCalls = [];
  patchResolvers = [];
  deferPatches = false;
  useVoicePrefsStore.setState({
    showUserTranscript: false,
    showAssistantTranscript: false,
  });
});

afterEach(() => cleanup());

/**
 * Render the menu and open the gear popover. The QueryClientProvider serves
 * the real `useSerializedConfigSelection` the mock hook always calls.
 */
function openMenu() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <VoiceRoomSettingsMenu triggerClassName="ctrl" assistantId="asst_test" />
    </QueryClientProvider>,
  );
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

  test("captions row keeps its label beside the icon", () => {
    openMenu();
    expect(screen.getByText("Captions")).toBeTruthy();
    expect(screen.getByLabelText("Show captions")).toBeTruthy();
  });

  test("no pause-before-reply control (removed with the two-tier model)", () => {
    openMenu();
    expect(screen.queryByLabelText("Pause before reply")).toBeNull();
  });

  test("a bring-your-own provider gets a disabled Voice row and a Settings link", () => {
    voiceSelection = { ...voiceSelection, available: false, isByok: true };
    openMenu();
    // Disabled rather than hidden, so the option is visibly unavailable rather
    // than missing, with the one place it can be changed right under it.
    const row = screen.getByText("Your API key").closest("button");
    expect(row?.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("link", { name: "Change voice in Settings" }),
    ).toBeTruthy();
  });

  test("collapses the Voice row entirely while availability is unknown", () => {
    // Not managed AND not confirmed BYO (config still loading) — showing the
    // BYO row here would flash a wrong state on every open.
    openMenu();
    expect(screen.queryByText("Voice")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("hides the Listening language row when selection is unavailable", () => {
    // Auto-detecting providers and old daemons report unavailable; the menu
    // must show no language control rather than one the daemon ignores.
    openMenu();
    expect(screen.queryByText("Listening language")).toBeNull();
  });

  test("shows the Listening language row with the current pick", () => {
    languageSelection = {
      ...languageSelection,
      available: true,
      currentCode: "es",
    };
    openMenu();
    const row = screen.getByText("Listening language").closest("button");
    expect(row?.textContent).toContain("Spanish (Español)");
  });

  test("clicking the language row swaps the popover for the picker modal", () => {
    languageSelection = { ...languageSelection, available: true };
    openMenu();
    fireEvent.click(screen.getByText("Listening language"));
    // The popover closes (its Captions toggle unmounts) so the picker isn't
    // stacked inside the popover's transformed wrapper...
    expect(screen.queryByLabelText("Show captions")).toBeNull();
    // ...and the modal opens outside it, caption and options included.
    expect(
      screen.getByRole("listbox", { name: "Listening language" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Applies from your next spoken turn."),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: /English \(default\)/ }),
    ).toBeTruthy();
  });

  test("picking a language passes its code to selectLanguage and closes the picker", () => {
    languageSelection = { ...languageSelection, available: true };
    openMenu();
    fireEvent.click(screen.getByText("Listening language"));
    fireEvent.click(
      screen.getByRole("option", { name: /French \(Français\)/ }),
    );
    expect(languagePicks).toEqual(["fr"]);
    // A pick hot-applies (nothing to save), so it also dismisses the picker.
    expect(
      screen.queryByRole("listbox", { name: "Listening language" }),
    ).toBeNull();
  });

  test("arrow keys walk the language options and Enter picks the focused one", async () => {
    languageSelection = { ...languageSelection, available: true };
    const user = userEvent.setup();
    openMenu();
    fireEvent.click(screen.getByText("Listening language"));
    // The options are buttons, so Tab reaches them; arrows then rove focus.
    const options = screen.getAllByRole("option");
    options[0].focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(options[1]);
    // Enter activates the focused option like a click: the pick lands and the
    // picker closes. Option 1 is Multilingual ("multi") for the vellum
    // provider with no language set.
    await user.keyboard("{Enter}");
    expect(languagePicks).toEqual(["multi"]);
    expect(
      screen.queryByRole("listbox", { name: "Listening language" }),
    ).toBeNull();
  });

  test("Home and End jump focus to the first and last language option", async () => {
    languageSelection = { ...languageSelection, available: true };
    const user = userEvent.setup();
    openMenu();
    fireEvent.click(screen.getByText("Listening language"));
    const options = screen.getAllByRole("option");
    options[0].focus();
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(options[options.length - 1]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(options[0]);
  });

  test("opening the picker focuses the selected option, the list's one tab stop", () => {
    languageSelection = {
      ...languageSelection,
      available: true,
      currentCode: "es",
    };
    openMenu();
    fireEvent.click(screen.getByText("Listening language"));
    // Focus starts on the configured language, not the first option: from
    // here Enter re-picks Spanish instead of overwriting it with English.
    const spanish = screen.getByRole("option", {
      name: /Spanish \(Español\)/,
    });
    expect(document.activeElement).toBe(spanish);
    // Roving tabindex anchored on the selection: only the selected option is
    // tabbable, the rest are reached with the arrow keys.
    expect(spanish.tabIndex).toBe(0);
    for (const option of screen.getAllByRole("option")) {
      if (option !== spanish) {
        expect(option.tabIndex).toBe(-1);
      }
    }
  });

  test("a slow write keeps picks serialized across picker close and reopen", async () => {
    // Real write chain (mocked transport), with every PATCH held open until
    // the test releases it.
    serializedSelection = true;
    deferPatches = true;
    const user = userEvent.setup();
    openMenu();
    fireEvent.click(screen.getByText("Listening language"));

    // First pick: its PATCH issues and stays in flight; the picker closes.
    await user.click(
      screen.getByRole("option", { name: /Spanish \(Español\)/ }),
    );
    expect(patchCalls).toEqual([{ language: "es" }]);
    expect(
      screen.queryByRole("listbox", { name: "Listening language" }),
    ).toBeNull();

    // Reopen and pick again while the first write is still unresolved. The
    // hook state survived the picker unmount: the reopened list shows the
    // pending Spanish pick as selected.
    fireEvent.click(screen.getByRole("button", { name: "Voice settings" }));
    fireEvent.click(screen.getByText("Listening language"));
    expect(
      screen
        .getByRole("option", { name: /Spanish \(Español\)/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    await user.click(
      screen.getByRole("option", { name: /French \(Français\)/ }),
    );

    // The strongest observable of the shared chain: the second PATCH has not
    // issued while the first is unresolved. Two independent chains (the
    // pre-fix bug) would have fired it immediately.
    expect(patchCalls).toEqual([{ language: "es" }]);

    // Releasing the first write lets the queued one issue, in pick order.
    await act(async () => {
      patchResolvers.shift()?.();
    });
    await act(async () => {});
    expect(patchCalls).toEqual([{ language: "es" }, { language: "fr" }]);
  });

  test("language row leaves the Captions toggle and Voice row intact", () => {
    languageSelection = { ...languageSelection, available: true };
    voiceSelection = { ...voiceSelection, available: false, isByok: true };
    openMenu();
    // Captions still flips both prefs together.
    fireEvent.click(screen.getByLabelText("Show captions"));
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(true);
    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(true);
    // The Voice row (BYO variant here) still renders alongside the language
    // row.
    expect(screen.getByText("Your API key")).toBeTruthy();
    expect(screen.getByText("Listening language")).toBeTruthy();
  });
});
