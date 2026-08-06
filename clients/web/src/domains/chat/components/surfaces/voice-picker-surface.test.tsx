/**
 * Tests for `VoicePickerSurface`, the inline chat card that hosts the shared
 * managed-voice picker.
 *
 * Load-bearing behavior:
 *   - a managed assistant gets the fetched voice rows inside the surface card,
 *   - picking a voice PATCHes `services.tts.providers.vellum.model`,
 *   - picking a voice submits no surface action, so auditioning several voices
 *     never fires an assistant turn,
 *   - a BYO assistant gets the Models & Services pointer, not an empty card.
 *
 * The daemon queries, the config PATCH, and audio playback are mocked.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import type { Surface } from "@/domains/chat/types/types";

const ASSISTANT_ID = "asst_1";

let orgReady = true;
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

let daemonConfigData: { services: Record<string, unknown> } = {
  services: { tts: { provider: "vellum" } },
};
let providersData: { providers: unknown[] } = {
  providers: [
    { id: "vellum", displayName: "Vellum", supportsVoiceSelection: true },
  ],
};
let managedVoicesData: { voices: unknown[]; defaultModel: string | null } = {
  voices: [],
  defaultModel: null,
};
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ttsProvidersGetOptions: () => ({
    queryKey: ["tts-providers-test"],
    queryFn: () => Promise.resolve(providersData),
    initialData: providersData,
  }),
  configGetOptions: () => ({
    queryKey: ["config-get-test"],
    queryFn: () => Promise.resolve(daemonConfigData),
    initialData: daemonConfigData,
  }),
  configGetQueryKey: () => ["config-get-test"],
  ttsManagedvoicesGetOptions: () => ({
    queryKey: ["tts-managed-voices-test"],
    queryFn: () => Promise.resolve(managedVoicesData),
    initialData: managedVoicesData,
  }),
}));

const configPatchCalls: { path?: unknown; body?: unknown }[] = [];
mock.module("@/generated/daemon/sdk.gen", () => ({
  configPatch: async (opts: { path?: unknown; body?: unknown }) => {
    configPatchCalls.push(opts);
    return { response: { ok: true, status: 200 } };
  },
}));

const { VoicePickerSurface } =
  await import("@/domains/chat/components/surfaces/voice-picker-surface");

const SURFACE: Surface = {
  surfaceId: "surface-voice-1",
  surfaceType: "voice_picker",
  title: "Pick a voice",
  data: {},
};

beforeAll(() => {
  (
    window.HTMLMediaElement.prototype as unknown as {
      play: () => Promise<void>;
    }
  ).play = () => Promise.resolve();
  (
    window.HTMLMediaElement.prototype as unknown as { pause: () => void }
  ).pause = () => {};
});

const onActionCalls: unknown[][] = [];

function renderSurface(assistantId: string | null = ASSISTANT_ID) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <VoicePickerSurface
          surface={SURFACE}
          onAction={(...args) => {
            onActionCalls.push(args);
          }}
          assistantId={assistantId}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function pickZeus() {
  const zeus = screen
    .getAllByRole("option")
    .find((o) => o.textContent?.includes("Deep, trustworthy"));
  if (!zeus) {
    throw new Error("expected the Zeus option");
  }
  fireEvent.click(zeus);
}

beforeEach(() => {
  orgReady = true;
  configPatchCalls.length = 0;
  onActionCalls.length = 0;
  daemonConfigData = { services: { tts: { provider: "vellum" } } };
  providersData = {
    providers: [
      { id: "vellum", displayName: "Vellum", supportsVoiceSelection: true },
    ],
  };
  managedVoicesData = {
    voices: [
      {
        model: "EXAVITQu4vr4xnSDxMaL",
        label: "Sarah",
        description: "American · professional, reassuring, confident",
        sampleUrl: "https://example.test/sarah.mp3",
        source: "elevenlabs",
      },
      {
        model: "aura-2-zeus-en",
        label: "Zeus",
        description: "American · deep, trustworthy, smooth",
        sampleUrl: "https://example.test/zeus.wav",
        source: "elevenlabs",
      },
    ],
    defaultModel: "EXAVITQu4vr4xnSDxMaL",
  };
});
afterEach(cleanup);

describe("VoicePickerSurface", () => {
  test("renders the fetched voices inside the surface card", () => {
    renderSurface();

    expect(screen.getByText("Pick a voice")).toBeTruthy();
    const rows = screen.getAllByRole("option");
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.textContent ?? "").join(" ")).toContain(
      "Deep, trustworthy, smooth",
    );
  });

  test("picking a voice PATCHes services.tts.providers.vellum.model", async () => {
    renderSurface();
    pickZeus();

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.path).toEqual({ assistant_id: ASSISTANT_ID });
    expect(configPatchCalls[0]!.body).toEqual({
      services: { tts: { providers: { vellum: { model: "aura-2-zeus-en" } } } },
    });
  });

  test("picking a voice submits no surface action", async () => {
    renderSurface();
    pickZeus();

    // The write is what the card does instead of an action. Waiting for it
    // means the action would have been submitted by now if the card submitted
    // one, and every audition click would cost an assistant turn.
    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(onActionCalls.length).toBe(0);
  });

  test("a BYO assistant gets the Models & Services pointer, not an empty card", () => {
    daemonConfigData = { services: { tts: { provider: "elevenlabs" } } };
    renderSurface();

    expect(screen.queryByRole("listbox")).toBeNull();
    const link = screen.getByRole("link", { name: "Models & Services" });
    expect(link.getAttribute("href")).toBe(
      "/assistant/settings/ai#text-to-speech",
    );
  });
});
