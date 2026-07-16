/**
 * Tests that `TextToSpeechCard`'s Save provisions the *daemon* (not just
 * localStorage): it stores the API key in the credential store and PATCHes
 * `services.tts`, mapping the "Voice ID" input to the provider-specific config
 * field (`referenceId` for Fish Audio, `voiceId` for ElevenLabs/xAI). The
 * server-side live-voice session reads that config + CES, so this is what makes
 * a UI save actually reach live voice.
 *
 * The providers query is disabled (useIsOrgReady → false) so the card falls
 * back to the static TTS catalog and performs no network fetch.
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

const ASSISTANT_ID = "asst-test";

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
// leaves the daemon with no tts provider, so the happy-path tests still PATCH it.
let daemonConfigData: { services: Record<string, unknown> } = { services: {} };
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ttsProvidersGetOptions: () => ({
    queryKey: ["tts-providers-test"],
    queryFn: () => Promise.resolve({ providers: [] }),
  }),
  configGetOptions: () => ({
    queryKey: ["config-get-test"],
    queryFn: () => Promise.resolve(daemonConfigData),
    initialData: daemonConfigData,
  }),
  configGetQueryKey: () => ["config-get-test"],
}));

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

const { TextToSpeechCard } =
  await import("@/domains/settings/ai/text-to-speech-card");

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TextToSpeechCard />
    </QueryClientProvider>,
  );
}

function selectProvider(label: string): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label="TTS provider"]',
  );
  if (!trigger) {
    throw new Error("expected the TTS provider dropdown trigger");
  }
  fireEvent.click(trigger);
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === label);
  if (!option) {
    throw new Error(`expected option "${label}"`);
  }
  fireEvent.click(option);
}

function setMode(label: "Managed" | "Your Own"): void {
  const group = screen.getByRole("radiogroup", { name: "Service mode" });
  fireEvent.click(within(group).getByRole("radio", { name: label }));
}

describe("TextToSpeechCard — daemon provisioning on Save", () => {
  beforeEach(() => {
    localStorage.clear();
    credentialsSetCalls.length = 0;
    configPatchCalls.length = 0;
    daemonConfigData = { services: {} };
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test("Fish Audio Save stores the key and maps Voice ID → services.tts.providers.fish-audio.referenceId", async () => {
    renderCard();

    selectProvider("Fish Audio");
    fireEvent.change(screen.getByPlaceholderText(/Fish Audio API key/), {
      target: { value: "fish-secret" },
    });
    fireEvent.change(screen.getByPlaceholderText("Enter a voice ID"), {
      target: { value: "voice-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(credentialsSetCalls).toHaveLength(1);
    expect(credentialsSetCalls[0]!.path).toEqual({
      assistant_id: ASSISTANT_ID,
    });
    expect(credentialsSetCalls[0]!.body).toMatchObject({
      service: "fish-audio",
      field: "api_key",
      value: "fish-secret",
    });
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: {
        tts: {
          provider: "fish-audio",
          providers: { "fish-audio": { referenceId: "voice-123" } },
        },
      },
    });
  });

  test("does not clobber a daemon-set provider when only the key changes", async () => {
    // Daemon already has a provider configured elsewhere (CLI/other client).
    daemonConfigData = { services: { tts: { provider: "fish-audio" } } };
    renderCard();

    // Enter ONLY an API key; leave the dropdown on the daemon's provider.
    fireEvent.change(screen.getByPlaceholderText(/Fish Audio API key/), {
      target: { value: "fish-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(credentialsSetCalls.length).toBe(1));
    // The config PATCH (if any) must not carry a `provider` key — re-saving a
    // key must not switch the live provider.
    const ttsBody = configPatchCalls[0]?.body as
      { services?: { tts?: Record<string, unknown> } } | undefined;
    expect(ttsBody?.services?.tts ?? {}).not.toHaveProperty("provider");
  });

  test("saving a key from the Your Own panel switches a managed-mode daemon back", async () => {
    // Managed speech was auto-defaulted on connection; toggling to "Your Own"
    // and saving a BYOK key is explicit intent to use it, so the mode flips —
    // otherwise the key appears to save but the daemon stays on managed.
    daemonConfigData = {
      services: { tts: { provider: "fish-audio", mode: "managed" } },
    };
    renderCard();

    // The card opens on the Managed panel; toggle to reach the BYOK inputs.
    setMode("Your Own");
    fireEvent.change(screen.getByPlaceholderText(/Fish Audio API key/), {
      target: { value: "fish-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { tts: { provider: "fish-audio", mode: "your-own" } },
    });
  });

  test("a voice-ID-only save from the Your Own panel leaves managed mode", async () => {
    // Reaching the voice-ID input requires toggling off Managed, so saving —
    // even without a new key — is explicit intent to use your own provider and
    // must flip the daemon off managed.
    daemonConfigData = {
      services: { tts: { provider: "fish-audio", mode: "managed" } },
    };
    renderCard();

    setMode("Your Own");
    fireEvent.change(screen.getByPlaceholderText("Enter a voice ID"), {
      target: { value: "voice-456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { tts: { provider: "fish-audio", mode: "your-own" } },
    });
    expect(credentialsSetCalls).toHaveLength(0);
  });

  test("a managed daemon reporting the reserved vellum provider gets a representable one", async () => {
    // A managed daemon may report provider "vellum", which the dropdown cannot
    // show and which is schema-invalid outside managed mode — the PATCH must
    // carry the card's selected provider instead.
    daemonConfigData = {
      services: { tts: { provider: "vellum", mode: "managed" } },
    };
    renderCard();

    setMode("Your Own");
    // The dropdown falls back to the first representable provider
    // (ElevenLabs, whose key placeholder is "sk_…").
    fireEvent.change(screen.getByPlaceholderText("sk_…"), {
      target: { value: "byok-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    const ttsBody = configPatchCalls[0]!.body as {
      services: { tts: Record<string, unknown> };
    };
    expect(ttsBody.services.tts.mode).toBe("your-own");
    expect(ttsBody.services.tts.provider).toBeDefined();
    expect(ttsBody.services.tts.provider).not.toBe("vellum");
    // The credential must land under the same provider the PATCH activates —
    // storing it under the reserved id would leave the activated provider
    // keyless while the save appears successful.
    expect(credentialsSetCalls).toHaveLength(1);
    expect((credentialsSetCalls[0]!.body as { service: string }).service).toBe(
      ttsBody.services.tts.provider as string,
    );
  });

  test("renders the Managed panel (no BYOK inputs) when the daemon is managed", async () => {
    daemonConfigData = {
      services: { tts: { provider: "fish-audio", mode: "managed" } },
    };
    renderCard();

    expect(
      screen.getByText(/Managed speech synthesis is included/),
    ).toBeDefined();
    // The provider dropdown belongs to the Your Own panel and must be absent.
    expect(
      document.querySelector('button[aria-label="TTS provider"]'),
    ).toBeNull();
  });

  // Provider "vellum" routes to managed regardless of mode, so a provider-only
  // managed config (written via the CLI) must render and escape like one
  // written by the toggle.
  test("renders the Managed panel for a provider-only vellum daemon", async () => {
    daemonConfigData = { services: { tts: { provider: "vellum" } } };
    renderCard();

    expect(
      screen.getByText(/Managed speech synthesis is included/),
    ).toBeDefined();
  });

  test("escaping a provider-only vellum daemon replaces the provider", async () => {
    daemonConfigData = { services: { tts: { provider: "vellum" } } };
    renderCard();

    setMode("Your Own");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    const ttsBody = configPatchCalls[0]!.body as {
      services: { tts: Record<string, unknown> };
    };
    expect(ttsBody.services.tts.mode).toBe("your-own");
    expect(ttsBody.services.tts.provider).toBeDefined();
    expect(ttsBody.services.tts.provider).not.toBe("vellum");
  });

  test("Managed Save writes the effective BYOK provider as the restore value", async () => {
    // The stored provider is the your-own restore value for toggling back;
    // effectiveTtsProvider routes managed mode to Vellum at runtime.
    daemonConfigData = { services: { tts: { provider: "fish-audio" } } };
    renderCard();

    setMode("Managed");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { tts: { mode: "managed", provider: "fish-audio" } },
    });
    expect(credentialsSetCalls).toHaveLength(0);
  });

  test("Managed Save always carries a representable provider (never vellum)", async () => {
    // A managed daemon may report the reserved "vellum" provider; the write
    // must fall back to a representable id so the restore value stays usable
    // and the schema (which forbids "vellum" only outside managed) is happy.
    daemonConfigData = {
      services: { tts: { provider: "vellum", mode: "managed" } },
    };
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    const ttsBody = configPatchCalls[0]!.body as {
      services: { tts: Record<string, unknown> };
    };
    expect(ttsBody.services.tts.mode).toBe("managed");
    expect(ttsBody.services.tts.provider).toBeDefined();
    expect(ttsBody.services.tts.provider).not.toBe("vellum");
  });

  test("toggling to Your Own is a saveable change on its own", async () => {
    // A managed daemon with a stored provider has nothing else to edit —
    // flipping the toggle must enable Save and persist mode: your-own.
    daemonConfigData = {
      services: { tts: { provider: "fish-audio", mode: "managed" } },
    };
    renderCard();

    setMode("Your Own");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { tts: { provider: "fish-audio", mode: "your-own" } },
    });
    expect(credentialsSetCalls).toHaveLength(0);
  });
});
