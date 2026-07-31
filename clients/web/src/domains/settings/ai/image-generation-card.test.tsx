/**
 * Tests for `ImageGenerationCard`'s provider-only configuration (the
 * Managed / Your Own mode toggle is gone — Vellum is a provider):
 *
 *   1. No mode segmented-control renders; the picker offers Vellum and
 *      Gemini.
 *   2. Vellum needs no API key, lists every model, and saves as a
 *      provider+mode pair for old-daemon compatibility.
 *   3. Gemini gates on a key and lists only gemini models.
 *   4. Legacy managed-mode daemon configs render as Vellum; an openai
 *      daemon config renders honestly without being clobbered.
 *
 * The design-library Dropdown is real, driven via its combobox trigger like
 * `web-search-card.test.tsx`.
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

// Controllable daemon config; `initialData` makes it available synchronously
// like a warm cache.
let daemonConfigData: { services: Record<string, unknown> } = { services: {} };
interface SdkCall {
  path?: unknown;
  body?: unknown;
}
const configPatchCalls: SdkCall[] = [];
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configGetOptions: () => ({
    queryKey: ["config-get-test"],
    queryFn: () => Promise.resolve(daemonConfigData),
    initialData: daemonConfigData,
  }),
  configGetQueryKey: () => ["config-get-test"],
  configGetSetQueryData: () => {},
  useConfigPatchMutation: () => ({
    mutateAsync: (opts: SdkCall) => {
      configPatchCalls.push(opts);
      return Promise.resolve(daemonConfigData);
    },
  }),
}));

const modelPutCalls: SdkCall[] = [];
mock.module("@/generated/daemon/sdk.gen", () => ({
  modelImagegenPut: (opts: SdkCall) => {
    modelPutCalls.push(opts);
    return Promise.resolve({ response: { ok: true, status: 200 } });
  },
}));

mock.module("@/domains/settings/ai/use-stored-credential-presence", () => ({
  useStoredCredentialPresence: () => ({
    hasStoredCredential: false,
    isLoading: false,
  }),
  credentialPresenceQueryKey: (...parts: unknown[]) => [
    "credential-presence-test",
    ...parts,
  ],
}));

const provisionedKeys: Array<{ provider: string; key: string }> = [];
mock.module("@/domains/settings/ai/use-daemon-config", () => ({
  useProvisionProviderKey: () => (provider: string, key: string) => {
    provisionedKeys.push({ provider, key });
    return Promise.resolve();
  },
}));

// Version gate for `provider: "vellum"` — supported by default; the
// old-daemon test flips it off.
let daemonSupportsVellumProvider = true;
mock.module(
  "@/lib/backwards-compat/use-supports-image-gen-vellum-provider",
  () => ({
    MIN_VERSION: "0.11.0",
    supportsImageGenVellumProvider: () => daemonSupportsVellumProvider,
  }),
);
mock.module("@/lib/backwards-compat/utils", () => ({
  whenAssistantVersionKnown: () => Promise.resolve(),
}));

const { ImageGenerationCard } =
  await import("@/domains/settings/ai/image-generation-card");
const { LS_IMAGE_GEN_PROVIDER } = await import("@/utils/local-settings-keys");

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImageGenerationCard />
    </QueryClientProvider>,
  );
}

function trigger(label: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    `button[role="combobox"][aria-label="${label}"]`,
  );
  if (!el) {
    throw new Error(`expected the "${label}" dropdown trigger`);
  }
  return el;
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

describe("ImageGenerationCard — provider-only configuration", () => {
  beforeEach(() => {
    localStorage.clear();
    configPatchCalls.length = 0;
    modelPutCalls.length = 0;
    provisionedKeys.length = 0;
    daemonSupportsVellumProvider = true;
    daemonConfigData = { services: {} };
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test("no Managed / Your Own mode toggle renders", () => {
    renderCard();

    expect(screen.queryByText("Managed")).toBeNull();
    expect(screen.queryByText("Your Own")).toBeNull();
    expect(trigger("Image generation provider")).toBeTruthy();
  });

  test("the provider picker offers Vellum, Gemini and OpenAI", () => {
    renderCard();

    fireEvent.click(trigger("Image generation provider"));
    expect(visibleOptions()).toEqual(["Vellum", "Gemini", "OpenAI"]);
  });

  test("Vellum hides the key field, lists every model, and saves the pair", async () => {
    renderCard();

    fireEvent.click(trigger("Image generation provider"));
    selectOption("Vellum");

    expect(screen.queryByText("API Key")).toBeNull();
    expect(
      screen.getByText(/Image generation runs through your Vellum account/),
    ).toBeTruthy();

    fireEvent.click(trigger("Image generation model"));
    expect(visibleOptions()).toEqual([
      "Nano Banana 2",
      "Nano Banana Pro",
      "GPT Image 2",
    ]);
    selectOption("GPT Image 2");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    // Written as a pair so the save stays valid on daemons whose schema
    // still couples provider "vellum" to mode "managed".
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: {
        "image-generation": { provider: "vellum", mode: "managed" },
      },
    });
    await waitFor(() => expect(modelPutCalls.length).toBe(1));
    expect(modelPutCalls[0]!.body).toMatchObject({ modelId: "gpt-image-2" });
    expect(provisionedKeys).toHaveLength(0);
    expect(localStorage.getItem(LS_IMAGE_GEN_PROVIDER)).toBe("vellum");
  });

  test("Gemini lists only gemini models and snaps an off-list model", async () => {
    localStorage.setItem("vellum:ai:imageGenModel", "gpt-image-2");
    renderCard();

    fireEvent.click(trigger("Image generation provider"));
    selectOption("Gemini");

    expect(screen.getByText("API Key")).toBeTruthy();
    expect(
      screen.getByPlaceholderText("Enter your Gemini API key"),
    ).toBeTruthy();

    fireEvent.click(trigger("Image generation model"));
    expect(visibleOptions()).toEqual(["Nano Banana 2", "Nano Banana Pro"]);
    // The stored gpt model is not servable by a Gemini key — snapped.
    expect(trigger("Image generation model").textContent).toContain(
      "Nano Banana 2",
    );
  });

  test("Gemini saves provider, mode and the provisioned key", async () => {
    renderCard();

    fireEvent.click(trigger("Image generation provider"));
    selectOption("Gemini");

    const keyInput = screen.getByPlaceholderText("Enter your Gemini API key");
    fireEvent.change(keyInput, { target: { value: "gm-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: {
        "image-generation": { provider: "gemini", mode: "your-own" },
      },
    });
    expect(provisionedKeys).toEqual([{ provider: "gemini", key: "gm-secret" }]);
  });

  // A config written by the legacy mode toggle marks managed via `mode`.
  test("a legacy managed-mode daemon renders as Vellum", () => {
    daemonConfigData = {
      services: { "image-generation": { mode: "managed", provider: "gemini" } },
    };
    renderCard();

    expect(trigger("Image generation provider").textContent).toContain(
      "Vellum",
    );
    expect(screen.queryByText("API Key")).toBeNull();
  });

  test("selecting OpenAI shows the openai key field and gpt models", async () => {
    renderCard();

    fireEvent.click(trigger("Image generation provider"));
    selectOption("OpenAI");

    expect(
      screen.getByPlaceholderText("Enter your OpenAI API key"),
    ).toBeTruthy();
    fireEvent.click(trigger("Image generation model"));
    expect(visibleOptions()).toEqual(["GPT Image 2"]);
  });

  test("an openai daemon config renders as the selected provider", async () => {
    daemonConfigData = {
      services: {
        "image-generation": { mode: "your-own", provider: "openai" },
      },
    };
    renderCard();

    expect(trigger("Image generation provider").textContent).toContain(
      "OpenAI",
    );
    expect(
      screen.getByPlaceholderText("Enter your OpenAI API key"),
    ).toBeTruthy();

    fireEvent.click(trigger("Image generation model"));
    expect(visibleOptions()).toEqual(["GPT Image 2"]);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: {
        "image-generation": { provider: "openai", mode: "your-own" },
      },
    });
  });

  test("a daemon predating the vellum enum still gets explicit BYOK provider writes", async () => {
    // Only "vellum" is unrepresentable on old daemons; gemini/openai are in
    // the old enum, so a provider switch must not be dropped.
    daemonSupportsVellumProvider = false;
    renderCard();

    fireEvent.click(trigger("Image generation provider"));
    selectOption("Gemini");
    const keyInput = screen.getByPlaceholderText("Enter your Gemini API key");
    fireEvent.change(keyInput, { target: { value: "gm-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: {
        "image-generation": { provider: "gemini", mode: "your-own" },
      },
    });
  });

  test("a stale stored model is reconciled against the provider before save", async () => {
    // gpt-image-2 was selectable under the legacy managed toggle; under a
    // gemini daemon config it must snap to a gemini model, not save a
    // provider/model mismatch.
    localStorage.setItem("vellum:ai:imageGenModel", "gpt-image-2");
    daemonConfigData = {
      services: {
        "image-generation": { mode: "your-own", provider: "gemini" },
      },
    };
    renderCard();

    expect(trigger("Image generation model").textContent).toContain(
      "Nano Banana 2",
    );

    const keyInput = screen.getByPlaceholderText("Enter your Gemini API key");
    fireEvent.change(keyInput, { target: { value: "gm-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(modelPutCalls.length).toBe(1));
    expect(modelPutCalls[0]!.body).toMatchObject({
      modelId: "gemini-3.1-flash-image-preview",
    });
    expect(provisionedKeys).toEqual([{ provider: "gemini", key: "gm-secret" }]);
  });

  test("a stale stored model reconciles with no daemon config at all", async () => {
    // The narrowest variant: no daemon data, provider falls back to the
    // localStorage default (gemini) while the stored model is a gpt one.
    // The derived reconciliation must still gate the save and the key
    // provisioning — never a gemini provider with an openai model/key.
    localStorage.setItem("vellum:ai:imageGenModel", "gpt-image-2");
    daemonConfigData = { services: {} };
    renderCard();

    expect(trigger("Image generation provider").textContent).toContain(
      "Gemini",
    );
    expect(trigger("Image generation model").textContent).toContain(
      "Nano Banana 2",
    );

    const keyInput = screen.getByPlaceholderText("Enter your Gemini API key");
    fireEvent.change(keyInput, { target: { value: "gm-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(modelPutCalls.length).toBe(1));
    expect(modelPutCalls[0]!.body).toMatchObject({
      modelId: "gemini-3.1-flash-image-preview",
    });
    expect(provisionedKeys).toEqual([{ provider: "gemini", key: "gm-secret" }]);
    expect(localStorage.getItem("vellum:ai:imageGenModel")).toBe(
      "gemini-3.1-flash-image-preview",
    );
  });

  test("a daemon predating the vellum provider gets the legacy managed write", async () => {
    // Old daemon schemas reject provider "vellum" outright; the Vellum
    // selection degrades to the legacy mode-only representation the read
    // bridge renders as Vellum again.
    daemonSupportsVellumProvider = false;
    renderCard();

    fireEvent.click(trigger("Image generation provider"));
    selectOption("Vellum");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    const body = configPatchCalls[0]!.body as {
      services: { "image-generation": Record<string, unknown> };
    };
    expect(body.services["image-generation"]).toEqual({ mode: "managed" });
  });
});
