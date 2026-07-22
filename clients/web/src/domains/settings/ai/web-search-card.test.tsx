/**
 * Tests for `WebSearchCard`'s provider-only configuration (the Managed /
 * Your Own mode toggle is gone — Vellum is a provider like any other):
 *
 *   1. No mode segmented-control renders in the card header.
 *   2. Vellum is selectable, needs no API key, and saves as a
 *      provider+mode pair for old-daemon compatibility.
 *   3. BYOK providers still gate Save on a credential.
 *   4. Legacy managed-mode daemon configs render as Vellum — except
 *      Provider Native, which stays itself (mirrors migration 132).
 *
 * The design-library Dropdown is real, driven via its combobox trigger like
 * `speech-to-text-card.test.tsx`.
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

// Controllable daemon config the config-get query resolves to; `initialData`
// makes it available synchronously like a warm cache.
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
  configGetSetQueryData: () => {},
  useConfigPatchMutation: () => ({
    mutateAsync: (opts: SdkCall) => {
      configPatchCalls.push(opts);
      return Promise.resolve(daemonConfigData);
    },
  }),
}));

const provisionedKeys: Array<{ provider: string; key: string }> = [];
mock.module("@/domains/settings/ai/use-daemon-config", () => ({
  useProvisionProviderKey: () => (provider: string, key: string) => {
    provisionedKeys.push({ provider, key });
    return Promise.resolve();
  },
}));

let hasStoredCredential = false;
mock.module("@/domains/settings/ai/use-stored-credential-presence", () => ({
  useStoredCredentialPresence: () => ({ hasStoredCredential }),
  credentialPresenceQueryKey: (...parts: unknown[]) => [
    "credential-presence-test",
    ...parts,
  ],
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => false,
}));

// Version gate for `provider: "vellum"` — supported by default; the
// old-daemon test flips it off.
let daemonSupportsVellumProvider = true;
mock.module(
  "@/lib/backwards-compat/use-supports-web-search-vellum-provider",
  () => ({
    MIN_VERSION: "0.10.12",
    supportsWebSearchVellumProvider: () => daemonSupportsVellumProvider,
  }),
);
mock.module("@/lib/backwards-compat/utils", () => ({
  whenAssistantVersionKnown: () => Promise.resolve(),
}));

const { WebSearchCard } = await import("@/domains/settings/ai/web-search-card");
const { LS_WEB_SEARCH_PROVIDER } = await import("@/utils/local-settings-keys");

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <WebSearchCard />
    </QueryClientProvider>,
  );
}

function providerTrigger(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label="Web search provider"]',
  );
  if (!trigger) {
    throw new Error("expected the web search provider dropdown trigger");
  }
  return trigger;
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

describe("WebSearchCard — provider-only configuration", () => {
  beforeEach(() => {
    localStorage.clear();
    configPatchCalls.length = 0;
    provisionedKeys.length = 0;
    hasStoredCredential = false;
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
    // The provider dropdown renders unconditionally instead.
    expect(providerTrigger()).toBeTruthy();
  });

  test("Vellum and Provider Native are offered alongside the BYOK providers", () => {
    renderCard();

    fireEvent.click(providerTrigger());
    const options = visibleOptions();
    expect(options).toEqual([
      "Vellum",
      "Provider Native",
      "Perplexity",
      "Brave",
      "Tavily",
      "Firecrawl",
    ]);
  });

  test("selecting Vellum hides the API key field and saves the provider+mode pair", async () => {
    renderCard();

    fireEvent.click(providerTrigger());
    selectOption("Vellum");

    expect(screen.queryByText("API Key")).toBeNull();
    expect(
      screen.getByText(/Search runs through your Vellum account/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    // Written as a pair so the save stays valid on daemons whose schema
    // still couples provider "vellum" to mode "managed".
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: {
        "web-search": { provider: "vellum", mode: "managed" },
      },
    });
    expect(provisionedKeys).toHaveLength(0);
    expect(localStorage.getItem(LS_WEB_SEARCH_PROVIDER)).toBe("vellum");
  });

  test("Provider Native needs no key and saves with mode your-own", async () => {
    // Start from a non-default provider so Save enables on the change.
    daemonConfigData = {
      services: { "web-search": { provider: "brave", mode: "your-own" } },
    };
    renderCard();

    fireEvent.click(providerTrigger());
    selectOption("Provider Native");

    expect(screen.queryByText("API Key")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: {
        "web-search": {
          provider: "inference-provider-native",
          mode: "your-own",
        },
      },
    });
    expect(provisionedKeys).toHaveLength(0);
  });

  test("a BYOK provider gates Save on a key, then saves provider, mode and key", async () => {
    renderCard();

    fireEvent.click(providerTrigger());
    selectOption("Firecrawl");

    // No stored credential and no typed key: Save must stay disabled.
    const saveButton = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    const keyInput = screen.getByPlaceholderText("fc-...");
    fireEvent.change(keyInput, { target: { value: "fc-secret" } });
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(provisionedKeys).toEqual([
      { provider: "firecrawl", key: "fc-secret" },
    ]);
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: {
        "web-search": { provider: "firecrawl", mode: "your-own" },
      },
    });
  });

  test("a daemon predating the vellum provider gets the legacy managed write", async () => {
    // Old daemon schemas reject provider "vellum" outright; the Vellum
    // selection must degrade to the legacy Managed representation — mode
    // only, letting the deep-merge keep the stored provider so the read
    // bridge renders the pair as Vellum again.
    daemonSupportsVellumProvider = false;
    renderCard();

    fireEvent.click(providerTrigger());
    selectOption("Vellum");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    const body = configPatchCalls[0]!.body as {
      services: { "web-search": Record<string, unknown> };
    };
    expect(body.services["web-search"]).toEqual({ mode: "managed" });
  });

  // A config written by the legacy mode toggle marks managed via `mode`
  // while `provider` holds the BYOK restore value.
  test("a legacy managed-mode daemon renders as Vellum", () => {
    daemonConfigData = {
      services: { "web-search": { mode: "managed", provider: "brave" } },
    };
    renderCard();

    expect(providerTrigger().textContent).toContain("Vellum");
    expect(screen.queryByText("API Key")).toBeNull();
  });

  test("a legacy managed-mode Provider Native daemon stays Provider Native", () => {
    // The platform default config: managed mode never meant "Vellum search"
    // for Provider Native — migration 132 preserves it, so must the card.
    daemonConfigData = {
      services: {
        "web-search": {
          mode: "managed",
          provider: "inference-provider-native",
        },
      },
    };
    renderCard();

    expect(providerTrigger().textContent).toContain("Provider Native");
    expect(providerTrigger().textContent).not.toContain("Vellum");
  });

  test("escaping a legacy managed-mode daemon resets mode alongside the provider", async () => {
    // Without the mode reset, the stale `mode: "managed"` would win over the
    // BYOK provider choice and the user would silently stay on Vellum.
    daemonConfigData = {
      services: { "web-search": { mode: "managed", provider: "brave" } },
    };
    hasStoredCredential = true;
    renderCard();

    fireEvent.click(providerTrigger());
    selectOption("Brave");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configPatchCalls.length).toBe(1));
    expect(configPatchCalls[0]!.body).toMatchObject({
      services: {
        "web-search": { provider: "brave", mode: "your-own" },
      },
    });
  });
});
