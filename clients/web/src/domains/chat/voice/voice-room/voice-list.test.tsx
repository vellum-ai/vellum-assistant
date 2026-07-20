/**
 * Tests for `VoiceList` — the managed-voice selection + per-voice audition
 * shared by the first-run card (inline) and the "Choose a voice" modal.
 *
 * Load-bearing behavior:
 *   - lists the fetched voices, sorted by character traits, labelled
 *     traits-first with the accent as a quiet suffix (no proper name, no source),
 *   - selecting a voice PATCHes `services.tts.providers.vellum.model`,
 *   - each row previews its own voice via the hosted sample,
 *   - renders nothing for a non-managed assistant.
 *
 * The daemon queries + config PATCH + audio playback are mocked.
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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
  providers: [{ id: "vellum", displayName: "Vellum", supportsVoiceSelection: true }],
};
let managedVoicesData: { voices: unknown[]; defaultModel: string | null } = {
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
      source: "deepgram",
    },
  ],
  defaultModel: "EXAVITQu4vr4xnSDxMaL",
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
  configPatch: (opts: { path?: unknown; body?: unknown }) => {
    configPatchCalls.push(opts);
    return Promise.resolve({ response: { ok: true, status: 200 } });
  },
}));

const { VoiceList } = await import(
  "@/domains/chat/voice/voice-room/voice-list"
);

beforeAll(() => {
  (window.HTMLMediaElement.prototype as unknown as { play: () => Promise<void> }).play =
    () => Promise.resolve();
  (window.HTMLMediaElement.prototype as unknown as { pause: () => void }).pause =
    () => {};
});

function renderList(assistantId: string | null = ASSISTANT_ID) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <VoiceList assistantId={assistantId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  orgReady = true;
  configPatchCalls.length = 0;
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
        source: "deepgram",
      },
    ],
    defaultModel: "EXAVITQu4vr4xnSDxMaL",
  };
});
afterEach(cleanup);

describe("VoiceList", () => {
  test("groups by accent; rows show sentence-cased traits, marked selected", () => {
    renderList();
    // Accent becomes a group header, not a per-row suffix.
    expect(screen.getByRole("group", { name: "American" })).toBeTruthy();

    const rows = screen.getAllByRole("option");
    // Within the group, sorted by traits: "Deep…" before "Professional…".
    expect(rows[0]!.textContent).toContain("Deep, trustworthy, smooth");
    expect(rows[1]!.textContent).toContain("Professional, reassuring");
    // The accent is not repeated on each row.
    expect(rows[0]!.textContent).not.toContain("American");
    // The current voice (default = Sarah) is marked selected in place.
    expect(rows[1]!.getAttribute("aria-selected")).toBe("true");
    expect(rows[0]!.getAttribute("aria-selected")).toBe("false");
    // No proper name, no upstream source.
    const all = rows.map((r) => r.textContent ?? "").join(" ");
    expect(all).not.toContain("Sarah");
    expect(all).not.toContain("Zeus");
    expect(all).not.toContain("ElevenLabs");
    expect(all).not.toContain("Deepgram");
  });

  test("selecting a voice PATCHes services.tts.providers.vellum.model", async () => {
    renderList();
    // Default (Sarah) is current; pick Zeus.
    const zeus = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("Deep, trustworthy"));
    if (!zeus) throw new Error("expected the Zeus option");
    fireEvent.click(zeus);

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.path).toEqual({ assistant_id: ASSISTANT_ID });
    expect(configPatchCalls[0]!.body).toEqual({
      services: { tts: { providers: { vellum: { model: "aura-2-zeus-en" } } } },
    });
  });

  test("each row previews its own voice via the hosted sample", async () => {
    let played = "";
    (window.HTMLMediaElement.prototype as unknown as { play: () => Promise<void> }).play =
      function (this: HTMLAudioElement) {
        played = this.src;
        return Promise.resolve();
      };
    renderList();

    fireEvent.click(
      screen.getByRole("button", { name: /Preview .*deep, trustworthy/ }),
    );
    await waitFor(() => expect(played).toContain("zeus.wav"));
    // Previewing must not select.
    expect(configPatchCalls.length).toBe(0);
  });

  test("while previewing, the control becomes a stop that cancels it", async () => {
    renderList();
    fireEvent.click(
      screen.getByRole("button", { name: /Preview .*deep, trustworthy/ }),
    );
    // The row's control flips to a stop affordance while playing.
    const stopButton = await screen.findByRole("button", {
      name: "Stop preview",
    });
    fireEvent.click(stopButton);
    // Stopped: no stop control remains, and stopping never selects.
    expect(screen.queryByRole("button", { name: "Stop preview" })).toBeNull();
    expect(configPatchCalls.length).toBe(0);
  });

  test("renders nothing for a non-managed assistant", () => {
    daemonConfigData = { services: { tts: { provider: "elevenlabs" } } };
    renderList();
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
