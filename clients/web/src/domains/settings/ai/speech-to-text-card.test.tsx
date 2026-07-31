/**
 * Tests for `SpeechToTextCard`'s "macOS Native Dictation" provider option:
 *
 *   1. The option only appears when the renderer can reach the mac helper's
 *      recognizer (the macOS Electron shell) — never on web/iOS.
 *   2. Selecting it hides the API-key field and shows the System Settings →
 *      Keyboard → Dictation prerequisite warning; Save persists the choice.
 *   3. A persisted native choice on a build without the capability falls
 *      back to the default provider instead of an empty dropdown.
 *
 * Plus the "Spoken language" control: a trigger row opening the shared
 * search-first picker, shown only when the daemon reports the configured
 * provider as manually language-selectable, hidden for auto-detecting
 * providers and old daemons that omit the capability field.
 *
 * The native-dictation runtime module is mocked (its real implementation
 * imports a Vite `?worker&url` asset and probes `window.vellum`); the
 * design-library Dropdown is real, driven via its combobox trigger like
 * `provider-create-form.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

let nativeDictationSupported = false;
mock.module("@/runtime/native-dictation-partials", () => ({
  isNativeDictationSupported: () => nativeDictationSupported,
}));

const ASSISTANT_ID = "asst-test";
// SpeechToTextCard reads the active assistant id (throws outside the gate);
// seed a fixed id, and stub toast so the barrel render stays inert.
mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));
// Mutable so the Spoken-language tests can enable the org-gated queries the
// language hook depends on; the provider tests keep the gate closed.
let orgReady = false;
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));

// Controllable daemon config the config-get query resolves to. `initialData`
// makes it available even though the query is `enabled: isOrgReady` (false),
// mirroring how the real query would already be cached. Default `{ services: {} }`
// leaves the daemon with no stt provider, so the happy-path tests still PATCH it.
let daemonConfigData: { services: Record<string, unknown> } = { services: {} };
// Provider capability probe backing the Spoken-language dropdown. Default
// empty: the language control stays hidden in the provider-focused tests.
let providerCatalogData: {
  providers: {
    id: string;
    displayName: string;
    languageSelection?: "manual" | "auto";
  }[];
} = { providers: [] };
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: () => ({
    queryKey: ["config-get-test"],
    queryFn: () => Promise.resolve(daemonConfigData),
    initialData: daemonConfigData,
  }),
  configGetQueryKey: () => ["config-get-test"],
  sttProvidersGetOptions: () => ({
    queryKey: ["stt-providers-test"],
    queryFn: () => Promise.resolve(providerCatalogData),
    initialData: providerCatalogData,
  }),
}));

// Capture the daemon writes Save now performs (CES key + services.stt config).
interface SdkCall {
  path?: unknown;
  body?: unknown;
}
const credentialsSetCalls: SdkCall[] = [];
const configPatchCalls: SdkCall[] = [];
mock.module("@/generated/daemon/sdk.gen", () => ({
  credentialsSetPost: (opts: SdkCall) => {
    credentialsSetCalls.push(opts);
    return Promise.resolve({ response: { ok: true, status: 200 } });
  },
  configPatch: (opts: SdkCall) => {
    configPatchCalls.push(opts);
    return Promise.resolve({ response: { ok: true, status: 200 } });
  },
}));

const { SpeechToTextCard } =
  await import("@/domains/settings/ai/speech-to-text-card");
const { LS_STT_PROVIDER } = await import("@/utils/local-settings-keys");

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SpeechToTextCard />
    </QueryClientProvider>,
  );
}

function openProviderDropdown(): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label="STT provider"]',
  );
  if (!trigger) {
    throw new Error("expected the STT provider dropdown trigger");
  }
  fireEvent.click(trigger);
}

function visibleOptions(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map((o) => o.textContent?.trim() ?? "");
}

/** Click an option in the already-open listbox (the trigger toggles). */
function selectOption(label: string): void {
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === label);
  if (!option) {
    throw new Error(
      `expected option "${label}" — saw: ${visibleOptions().join(", ")}`,
    );
  }
  fireEvent.click(option);
}

describe("SpeechToTextCard — macOS Native Dictation option", () => {
  beforeEach(() => {
    localStorage.clear();
    nativeDictationSupported = false;
    credentialsSetCalls.length = 0;
    configPatchCalls.length = 0;
    daemonConfigData = { services: {} };
    providerCatalogData = { providers: [] };
    orgReady = false;
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test("native option is absent when the helper recognizer is unavailable", () => {
    renderCard();

    openProviderDropdown();
    expect(visibleOptions()).not.toContain("macOS Native Dictation");
  });

  test("selecting the native option hides the API key field and shows the Dictation warning", () => {
    nativeDictationSupported = true;
    renderCard();

    openProviderDropdown();
    expect(visibleOptions()).toContain("macOS Native Dictation");

    selectOption("macOS Native Dictation");

    expect(screen.queryByText("API Key")).toBeNull();
    expect(
      screen.getByText(/System Settings → Keyboard, then enable Dictation/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(localStorage.getItem(LS_STT_PROVIDER)).toBe("macos-native");
    // macOS native dictation is client-only — Save must not touch the daemon.
    expect(credentialsSetCalls.length).toBe(0);
    expect(configPatchCalls.length).toBe(0);
  });

  test("selecting Deepgram and saving provisions the daemon (CES key + services.stt)", async () => {
    renderCard();

    // Deepgram is the default provider; a new key enables Save.
    const keyInput = screen.getByPlaceholderText(/Enter your Deepgram API key/);
    fireEvent.change(keyInput, { target: { value: "dg-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(credentialsSetCalls).toHaveLength(1);
    expect(credentialsSetCalls[0]!.path).toEqual({
      assistant_id: ASSISTANT_ID,
    });
    expect(credentialsSetCalls[0]!.body).toMatchObject({
      service: "deepgram",
      field: "api_key",
      value: "dg-secret",
    });
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { stt: { provider: "deepgram" } },
    });
  });

  test("a stored native choice falls back to the default provider off Electron", () => {
    localStorage.setItem(LS_STT_PROVIDER, "macos-native");
    renderCard();

    const trigger = document.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="STT provider"]',
    );
    expect(trigger?.textContent).toContain("Deepgram");
    expect(screen.getByText("API Key")).toBeTruthy();
    // The fallback must also self-heal the persisted value — leaving
    // "macos-native" behind would diverge from what the UI shows, with
    // Save disabled so the user couldn't persist the correction.
    expect(localStorage.getItem(LS_STT_PROVIDER)).toBe("deepgram");
  });

  test("a legacy provider alias is not overwritten by the self-heal", () => {
    // "whisper" predates the current catalog ids; stt-api's
    // normalizeSttProviderId() still maps it at transcribe time, so merely
    // opening Settings must not rewrite it.
    localStorage.setItem(LS_STT_PROVIDER, "whisper");
    renderCard();

    expect(localStorage.getItem(LS_STT_PROVIDER)).toBe("whisper");
  });

  test("does not clobber a daemon-set provider when only the key changes", async () => {
    // Daemon already has a provider configured elsewhere (CLI/other client).
    daemonConfigData = { services: { stt: { provider: "deepgram" } } };
    renderCard();

    // Enter ONLY an API key; leave the dropdown on the daemon's provider.
    const keyInput = screen.getByPlaceholderText(/Enter your Deepgram API key/);
    fireEvent.change(keyInput, { target: { value: "dg-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(credentialsSetCalls.length).toBe(1));
    // The provider is unchanged and the daemon already has one, so no config
    // PATCH must fire (which would re-assert / risk clobbering the provider).
    const sttBody = configPatchCalls[0]?.body as
      | { services?: { stt?: Record<string, unknown> } }
      | undefined;
    expect(sttBody?.services?.stt ?? {}).not.toHaveProperty("provider");
  });

  test("selecting a provider from a Vellum daemon writes that provider", async () => {
    daemonConfigData = { services: { stt: { provider: "vellum" } } };
    renderCard();

    openProviderDropdown();
    selectOption("OpenAI");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { stt: { provider: "openai-whisper" } },
    });
    expect(credentialsSetCalls).toHaveLength(0);
  });
});

describe("SpeechToTextCard — Vellum provider", () => {
  beforeEach(() => {
    localStorage.clear();
    nativeDictationSupported = false;
    credentialsSetCalls.length = 0;
    configPatchCalls.length = 0;
    daemonConfigData = { services: {} };
    providerCatalogData = { providers: [] };
    orgReady = false;
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test("Vellum is offered in the provider dropdown", () => {
    renderCard();

    openProviderDropdown();
    expect(visibleOptions()).toContain("Vellum");
  });

  test("a vellum daemon provider renders as the selected option with no API key field", () => {
    daemonConfigData = { services: { stt: { provider: "vellum" } } };
    renderCard();

    const trigger = document.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="STT provider"]',
    );
    expect(trigger?.textContent).toContain("Vellum");
    // Vellum authenticates via the platform connection — there is no key.
    expect(screen.queryByText("API Key")).toBeNull();
    expect(
      screen.getByText(/Transcription runs through your Vellum account/),
    ).toBeTruthy();
  });

  test("selecting Vellum saves provider vellum and stores no credential", async () => {
    renderCard();

    openProviderDropdown();
    selectOption("Vellum");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    // Written as a pair so the save stays valid on daemons whose schema
    // still couples provider "vellum" to mode "managed".
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { stt: { provider: "vellum", mode: "managed" } },
    });
    expect(credentialsSetCalls).toHaveLength(0);
    expect(localStorage.getItem(LS_STT_PROVIDER)).toBe("vellum");
  });

  // A config written by the legacy mode toggle marks managed via `mode` while
  // `provider` holds the BYOK restore value.
  test("a legacy managed-mode daemon renders as Vellum", () => {
    daemonConfigData = {
      services: { stt: { mode: "managed", provider: "deepgram" } },
    };
    renderCard();

    const trigger = document.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="STT provider"]',
    );
    expect(trigger?.textContent).toContain("Vellum");
    expect(screen.queryByText("API Key")).toBeNull();
  });

  test("escaping a legacy managed-mode daemon resets mode alongside the provider", async () => {
    // Without the mode reset, the stale `mode: "managed"` would win over the
    // BYOK provider choice and the user would silently stay on Vellum.
    daemonConfigData = {
      services: { stt: { mode: "managed", provider: "deepgram" } },
    };
    renderCard();

    openProviderDropdown();
    selectOption("Deepgram");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { stt: { provider: "deepgram", mode: "your-own" } },
    });
  });

  test("leaving Vellum for native dictation writes a daemon-backed fallback", async () => {
    // Native is client-only (no daemon mapping), so without an explicit write
    // the daemon would stay on Vellum and a refetch would snap the dropdown
    // back to it.
    nativeDictationSupported = true;
    daemonConfigData = { services: { stt: { provider: "vellum" } } };
    renderCard();

    openProviderDropdown();
    selectOption("macOS Native Dictation");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { stt: { provider: "deepgram" } },
    });
    // The client keeps routing dictation locally.
    expect(localStorage.getItem(LS_STT_PROVIDER)).toBe("macos-native");
  });
});

describe("SpeechToTextCard: Spoken language picker", () => {
  beforeEach(() => {
    localStorage.clear();
    nativeDictationSupported = false;
    credentialsSetCalls.length = 0;
    configPatchCalls.length = 0;
    daemonConfigData = { services: {} };
    providerCatalogData = { providers: [] };
    // The language hook's queries are org-gated; open the gate so the
    // capability probe and config read resolve.
    orgReady = true;
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  function languageTrigger(): HTMLButtonElement | null {
    // A trigger row opening the search-first picker modal (not a combobox).
    return document.querySelector<HTMLButtonElement>(
      'button[aria-label="Spoken language"]',
    );
  }

  /** The picker modal's search field, present only while the picker is open. */
  function pickerSearch(): HTMLInputElement | null {
    return document.querySelector<HTMLInputElement>('input[role="combobox"]');
  }

  test("renders for a manually language-selectable provider and lists Multilingual", async () => {
    daemonConfigData = { services: { stt: { provider: "deepgram" } } };
    providerCatalogData = {
      providers: [
        {
          id: "deepgram",
          displayName: "Deepgram",
          languageSelection: "manual",
        },
      ],
    };
    renderCard();

    await waitFor(() => expect(languageTrigger()).not.toBeNull());
    fireEvent.click(languageTrigger()!);
    // Option rows render their description inline, so match on the prefix.
    expect(visibleOptions().some((o) => o.startsWith("Multilingual"))).toBe(
      true,
    );
    // The extended nova-3 roster is offered under deepgram.
    expect(visibleOptions()).toContain("Tamil (தமிழ்)");
  });

  test("the trigger opens the picker and a searched pick writes the code", async () => {
    daemonConfigData = { services: { stt: { provider: "deepgram" } } };
    providerCatalogData = {
      providers: [
        {
          id: "deepgram",
          displayName: "Deepgram",
          languageSelection: "manual",
        },
      ],
    };
    renderCard();

    await waitFor(() => expect(languageTrigger()).not.toBeNull());
    // The trigger row is a button into the picker dialog, not a combobox.
    expect(languageTrigger()!.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(languageTrigger()!);

    // Search narrows the list; picking the match hot-applies the code
    // through the language hook's config PATCH.
    const search = pickerSearch();
    expect(search).not.toBeNull();
    fireEvent.change(search!, { target: { value: "tamil" } });
    const options = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    );
    expect(options).toHaveLength(1);
    fireEvent.click(options[0]!);

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { stt: { language: "ta" } },
    });
    // A pick hot-applies (nothing to save), so it also closes the picker.
    expect(pickerSearch()).toBeNull();
  });

  test("does not render for an auto-detecting provider", () => {
    daemonConfigData = { services: { stt: { provider: "google-gemini" } } };
    providerCatalogData = {
      providers: [
        {
          id: "google-gemini",
          displayName: "Gemini",
          languageSelection: "auto",
        },
      ],
    };
    renderCard();

    expect(languageTrigger()).toBeNull();
  });

  test("hides while the form shows the client-only native provider", async () => {
    // The daemon reports its own (language-selectable) provider, but the
    // native recognizer never reads `services.stt.language`: a picker here
    // would PATCH a value nothing consumes.
    nativeDictationSupported = true;
    daemonConfigData = { services: { stt: { provider: "deepgram" } } };
    providerCatalogData = {
      providers: [
        {
          id: "deepgram",
          displayName: "Deepgram",
          languageSelection: "manual",
        },
      ],
    };
    renderCard();

    await waitFor(() => expect(languageTrigger()).not.toBeNull());

    openProviderDropdown();
    selectOption("macOS Native Dictation");

    expect(languageTrigger()).toBeNull();
  });

  test("hides when the draft switches to an auto-detecting provider", async () => {
    // Saved provider vellum (manual), dropdown switched to OpenAI without
    // saving: Whisper auto-detects, so a picker here would offer a language
    // the drafted provider ignores.
    daemonConfigData = { services: { stt: { provider: "vellum" } } };
    providerCatalogData = {
      providers: [
        { id: "vellum", displayName: "Vellum", languageSelection: "manual" },
        {
          id: "openai-whisper",
          displayName: "Whisper",
          languageSelection: "auto",
        },
      ],
    };
    renderCard();

    await waitFor(() => expect(languageTrigger()).not.toBeNull());

    openProviderDropdown();
    selectOption("OpenAI");

    expect(languageTrigger()).toBeNull();
  });

  test("hides when the draft switches between manual providers", async () => {
    // Saved provider deepgram (manual), dropdown switched to Vellum without
    // saving: both are manual, but a pick would hot-apply to the still
    // active deepgram config while the row advertises the draft's options,
    // so any pending provider draft hides the picker.
    daemonConfigData = { services: { stt: { provider: "deepgram" } } };
    providerCatalogData = {
      providers: [
        {
          id: "deepgram",
          displayName: "Deepgram",
          languageSelection: "manual",
        },
        { id: "vellum", displayName: "Vellum", languageSelection: "manual" },
      ],
    };
    renderCard();

    await waitFor(() => expect(languageTrigger()).not.toBeNull());

    openProviderDropdown();
    selectOption("Vellum");

    expect(languageTrigger()).toBeNull();
  });

  test("renders for an xai daemon without the Multilingual option", async () => {
    // xai is configurable via the CLI but unrepresentable in the dropdown
    // (which falls back to a placeholder); the picker still steers the xai
    // daemon config, whose adapter drops "multi", so the Multilingual entry
    // must not be offered.
    daemonConfigData = { services: { stt: { provider: "xai" } } };
    providerCatalogData = {
      providers: [
        { id: "xai", displayName: "xAI", languageSelection: "manual" },
      ],
    };
    renderCard();

    await waitFor(() => expect(languageTrigger()).not.toBeNull());
    fireEvent.click(languageTrigger()!);
    const options = visibleOptions();
    expect(options.some((o) => o.startsWith("Multilingual"))).toBe(false);
    expect(options).toContain("Spanish (Español)");
    // Unset language under xai is native auto-detection, so the default row
    // is Auto-detect and an explicit English entry makes the pin writable.
    expect(options.some((o) => o.includes("Auto-detect (default)"))).toBe(true);
    expect(options).toContain("English");
  });

  test("an unset language under an xai daemon shows Auto-detect on the trigger", async () => {
    // The resolver sends no language when the config is unset, so xAI
    // detects it natively; an "English (default)" trigger misreports that.
    daemonConfigData = { services: { stt: { provider: "xai" } } };
    providerCatalogData = {
      providers: [
        { id: "xai", displayName: "xAI", languageSelection: "manual" },
      ],
    };
    renderCard();

    await waitFor(() => expect(languageTrigger()).not.toBeNull());
    expect(languageTrigger()!.textContent).toContain("Auto-detect (default)");
  });

  test("a persisted en under an xai daemon shows the English pin, not Auto-detect", async () => {
    // Under xai "en" is a deliberate pin: the display equivalence that folds
    // "en" into the default row applies only to providers whose unset state
    // decodes as English.
    daemonConfigData = {
      services: { stt: { provider: "xai", language: "en" } },
    };
    providerCatalogData = {
      providers: [
        { id: "xai", displayName: "xAI", languageSelection: "manual" },
      ],
    };
    renderCard();

    await waitFor(() => expect(languageTrigger()).not.toBeNull());
    expect(languageTrigger()!.textContent).toContain("English");
    expect(languageTrigger()!.textContent).not.toContain("Auto-detect");
  });

  test("a persisted multi under an xai daemon renders via the custom fallback", async () => {
    daemonConfigData = {
      services: { stt: { provider: "xai", language: "multi" } },
    };
    providerCatalogData = {
      providers: [
        { id: "xai", displayName: "xAI", languageSelection: "manual" },
      ],
    };
    renderCard();

    // The trigger shows the persisted truth even though xai ignores it.
    await waitFor(() => expect(languageTrigger()).not.toBeNull());
    expect(languageTrigger()!.textContent).toContain("multi (custom)");
  });

  test("shows an out-of-catalog configured language on the trigger", async () => {
    // Any non-empty string is a valid `services.stt.language` (CLI/chat can
    // write "en-US"); the trigger must show it rather than render blank.
    daemonConfigData = {
      services: { stt: { provider: "deepgram", language: "en-US" } },
    };
    providerCatalogData = {
      providers: [
        {
          id: "deepgram",
          displayName: "Deepgram",
          languageSelection: "manual",
        },
      ],
    };
    renderCard();

    await waitFor(() => expect(languageTrigger()).not.toBeNull());
    expect(languageTrigger()!.textContent).toContain("en-US");
  });

  test("hides when a stale localStorage provider settles the card off the steered daemon default", async () => {
    // No `services.stt` config, so the pick steers the daemon schema default
    // (deepgram, manual), but the cross-assistant localStorage choice settles
    // the card on auto-detecting Whisper with no pending draft. The mapped
    // branch of the gate requires the card's daemon mapping to equal the
    // steered provider, so no picker renders under the auto card.
    localStorage.setItem(LS_STT_PROVIDER, "openai");
    daemonConfigData = { services: {} };
    providerCatalogData = {
      providers: [
        {
          id: "deepgram",
          displayName: "Deepgram",
          languageSelection: "manual",
        },
        {
          id: "openai-whisper",
          displayName: "Whisper",
          languageSelection: "auto",
        },
      ],
    };
    renderCard();

    // The card settles on the localStorage provider (no draft pending).
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="STT provider"]',
    );
    await waitFor(() => expect(trigger?.textContent).toContain("OpenAI"));

    expect(languageTrigger()).toBeNull();
  });

  test("does not render when the daemon omits the capability field (old daemon)", () => {
    daemonConfigData = { services: { stt: { provider: "deepgram" } } };
    providerCatalogData = {
      providers: [{ id: "deepgram", displayName: "Deepgram" }],
    };
    renderCard();

    expect(languageTrigger()).toBeNull();
  });
});
