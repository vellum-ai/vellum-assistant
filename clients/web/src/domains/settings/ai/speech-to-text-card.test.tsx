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
  within,
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
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => false,
}));

// Controllable daemon config the config-get query resolves to. `initialData`
// makes it available even though the query is `enabled: isOrgReady` (false),
// mirroring how the real query would already be cached. Default `{ services: {} }`
// leaves the daemon with no stt provider, so the happy-path tests still PATCH it.
let daemonConfigData: { services: Record<string, unknown> } = { services: {} };
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: () => ({
    queryKey: ["config-get-test"],
    queryFn: () => Promise.resolve(daemonConfigData),
    initialData: daemonConfigData,
  }),
  configGetQueryKey: () => ["config-get-test"],
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
const { LS_STT_PROVIDER } =
  await import("@/domains/settings/ai/local-storage-keys");

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

function setMode(label: "Managed" | "Your Own"): void {
  const group = screen.getByRole("radiogroup", { name: "Service mode" });
  fireEvent.click(within(group).getByRole("radio", { name: label }));
}

describe("SpeechToTextCard — macOS Native Dictation option", () => {
  beforeEach(() => {
    localStorage.clear();
    nativeDictationSupported = false;
    credentialsSetCalls.length = 0;
    configPatchCalls.length = 0;
    daemonConfigData = { services: {} };
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
      { services?: { stt?: Record<string, unknown> } } | undefined;
    expect(sttBody?.services?.stt ?? {}).not.toHaveProperty("provider");
  });

  test("saving a key from the Your Own panel switches a managed-mode daemon back", async () => {
    // Managed speech was auto-defaulted on connection; toggling to "Your Own"
    // and saving a BYOK key is explicit intent to use it, so the mode flips —
    // otherwise the key appears to save but the daemon stays on managed.
    daemonConfigData = {
      services: { stt: { provider: "deepgram", mode: "managed" } },
    };
    renderCard();

    // The card opens on the Managed panel; toggle to reach the BYOK inputs.
    setMode("Your Own");
    const keyInput = screen.getByPlaceholderText(/Enter your Deepgram API key/);
    fireEvent.change(keyInput, { target: { value: "dg-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { stt: { provider: "deepgram", mode: "your-own" } },
    });
  });

  test("a provider change with no key from the Your Own panel leaves managed mode", async () => {
    // Reaching the provider dropdown requires toggling off Managed, so saving —
    // even without a new key — is explicit intent to use your own provider and
    // must flip the daemon off managed.
    daemonConfigData = {
      services: { stt: { provider: "deepgram", mode: "managed" } },
    };
    renderCard();

    setMode("Your Own");
    openProviderDropdown();
    selectOption("OpenAI");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { stt: { provider: "openai-whisper", mode: "your-own" } },
    });
    expect(credentialsSetCalls).toHaveLength(0);
  });

  test("renders the Managed panel (no BYOK inputs) when the daemon is managed", () => {
    daemonConfigData = {
      services: { stt: { provider: "deepgram", mode: "managed" } },
    };
    renderCard();

    expect(
      screen.getByText(/Managed transcription is included/),
    ).toBeDefined();
    // The provider dropdown belongs to the Your Own panel and must be absent.
    expect(
      document.querySelector('button[aria-label="STT provider"]'),
    ).toBeNull();
  });

  test("Managed Save writes a daemon-mapped provider as the restore value", async () => {
    // The stored provider is the your-own restore value for toggling back and
    // must be a valid daemon id; effectiveSttProvider routes managed mode to
    // Vellum at runtime.
    daemonConfigData = { services: { stt: { provider: "deepgram" } } };
    renderCard();

    setMode("Managed");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { stt: { mode: "managed", provider: "deepgram" } },
    });
    expect(credentialsSetCalls).toHaveLength(0);
  });

  test("Managed Save preserves an unlisted daemon provider as the restore value", async () => {
    // A valid daemon provider the dropdown can't represent (set via CLI) must
    // survive a managed save so toggling back restores it.
    daemonConfigData = { services: { stt: { provider: "google-gemini" } } };
    renderCard();

    setMode("Managed");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { stt: { mode: "managed", provider: "google-gemini" } },
    });
  });

  test("Managed Save repoints a native-dictation choice off macos-native", async () => {
    // prefersMacosNativeStt() keys off LS_STT_PROVIDER alone, so leaving it on
    // "macos-native" would keep this client bypassing managed STT even after
    // saving Managed.
    nativeDictationSupported = true;
    localStorage.setItem(LS_STT_PROVIDER, "macos-native");
    renderCard();

    setMode("Managed");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(localStorage.getItem(LS_STT_PROVIDER)).not.toBe("macos-native");
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { stt: { mode: "managed", provider: "deepgram" } },
    });
  });

  test("toggling to Your Own is a saveable change on its own", async () => {
    // A managed daemon with a stored provider has nothing else to edit —
    // flipping the toggle must enable Save and persist mode: your-own.
    daemonConfigData = {
      services: { stt: { provider: "deepgram", mode: "managed" } },
    };
    renderCard();

    setMode("Your Own");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { stt: { provider: "deepgram", mode: "your-own" } },
    });
    expect(credentialsSetCalls).toHaveLength(0);
  });
});
