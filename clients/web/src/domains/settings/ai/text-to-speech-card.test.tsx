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

const { TextToSpeechCard } = await import(
  "@/domains/settings/ai/text-to-speech-card"
);

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
  if (!trigger) {throw new Error("expected the TTS provider dropdown trigger");}
  fireEvent.click(trigger);
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === label);
  if (!option) {throw new Error(`expected option "${label}"`);}
  fireEvent.click(option);
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
    expect(credentialsSetCalls[0]!.path).toEqual({ assistant_id: ASSISTANT_ID });
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
      | { services?: { tts?: Record<string, unknown> } }
      | undefined;
    expect(ttsBody?.services?.tts ?? {}).not.toHaveProperty("provider");
  });
});
