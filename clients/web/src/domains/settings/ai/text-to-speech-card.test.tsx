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
let orgReady = false;
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));
// Controllable daemon config the config-get query resolves to. `initialData`
// makes it available even though the query is `enabled: isOrgReady` (false),
// mirroring how the real query would already be cached. Default `{ services: {} }`
// leaves the daemon with no tts provider, so the happy-path tests still PATCH it.
let daemonConfigData: { services: Record<string, unknown> } = { services: {} };
// When set, the tts-providers query resolves to this catalog (as `initialData`,
// so no async settling) — lets tests exercise a daemon-fetched provider list.
let ttsCatalogData: { providers: unknown[] } | undefined;
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ttsProvidersGetOptions: () => ({
    queryKey: ["tts-providers-test"],
    queryFn: () => Promise.resolve(ttsCatalogData ?? { providers: [] }),
    ...(ttsCatalogData ? { initialData: ttsCatalogData } : {}),
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

describe("TextToSpeechCard — daemon provisioning on Save", () => {
  beforeEach(() => {
    localStorage.clear();
    credentialsSetCalls.length = 0;
    configPatchCalls.length = 0;
    daemonConfigData = { services: {} };
    orgReady = false;
    ttsCatalogData = undefined;
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

  test("selecting a BYOK provider from a Vellum daemon writes that provider", async () => {
    daemonConfigData = { services: { tts: { provider: "vellum" } } };
    renderCard();

    selectProvider("Fish Audio");
    fireEvent.change(screen.getByPlaceholderText(/Fish Audio API key/), {
      target: { value: "fish-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { tts: { provider: "fish-audio" } },
    });
    // The credential must land under the provider the PATCH activates.
    expect(credentialsSetCalls).toHaveLength(1);
    expect((credentialsSetCalls[0]!.body as { service: string }).service).toBe(
      "fish-audio",
    );
  });
});

describe("TextToSpeechCard — Vellum provider", () => {
  beforeEach(() => {
    localStorage.clear();
    credentialsSetCalls.length = 0;
    configPatchCalls.length = 0;
    daemonConfigData = { services: {} };
    orgReady = false;
    ttsCatalogData = undefined;
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test("a vellum daemon provider hides the API key field and the Test button", () => {
    daemonConfigData = { services: { tts: { provider: "vellum" } } };
    renderCard();

    const trigger = document.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="TTS provider"]',
    );
    expect(trigger?.textContent).toContain("Vellum");
    // Vellum authenticates via the platform connection, so there is no key to
    // enter and nothing for the client-side Test path to use.
    expect(screen.queryByText("API Key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Test" })).toBeNull();
  });

  test("selecting Vellum saves provider vellum and stores no credential", async () => {
    renderCard();

    selectProvider("Vellum");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    // Written as a pair so the save stays valid on daemons whose schema
    // still couples provider "vellum" to mode "managed".
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { tts: { provider: "vellum", mode: "managed" } },
    });
    expect(credentialsSetCalls).toHaveLength(0);
  });

  // A config written by the legacy mode toggle marks managed via `mode` while
  // `provider` holds the BYOK restore value.
  test("a legacy managed-mode daemon renders as Vellum", () => {
    daemonConfigData = {
      services: { tts: { mode: "managed", provider: "fish-audio" } },
    };
    renderCard();

    const trigger = document.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="TTS provider"]',
    );
    expect(trigger?.textContent).toContain("Vellum");
    expect(screen.queryByText("API Key")).toBeNull();
  });

  test("escaping a legacy managed-mode daemon resets mode alongside the provider", async () => {
    // Without the mode reset, the stale `mode: "managed"` would win over the
    // BYOK provider choice and the user would silently stay on Vellum.
    daemonConfigData = {
      services: { tts: { mode: "managed", provider: "fish-audio" } },
    };
    renderCard();

    selectProvider("Fish Audio");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: { tts: { provider: "fish-audio", mode: "your-own" } },
    });
  });

  test("grafts the Vellum option onto a fetched catalog that lacks it", () => {
    // A daemon serving the pre-vellum catalog omits the managed option; the
    // card must still offer it, or a legacy managed config has no selectable
    // representation and managed TTS becomes unreachable from this UI.
    orgReady = true;
    ttsCatalogData = {
      providers: [
        {
          id: "elevenlabs",
          displayName: "ElevenLabs",
          subtitle: "High-quality voice synthesis.",
          supportsVoiceSelection: true,
          apiKeyPlaceholder: "sk_…",
          credentialsGuide: { description: "", url: "", linkLabel: "" },
        },
      ],
    };
    renderCard();

    const trigger = document.querySelector<HTMLButtonElement>(
      'button[role="combobox"][aria-label="TTS provider"]',
    );
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger!);
    const options = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((o) => o.textContent?.trim());
    expect(options).toContain("Vellum");
    expect(options).toContain("ElevenLabs");
  });
});
