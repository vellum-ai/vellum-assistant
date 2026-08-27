/**
 * Tests for the create-mode `ProfileEditorModal` — the provider-first reorder
 * + pre-fill + inline provider create flow (PR 3 of the
 * provider-first-profile-quick-add plan).
 *
 * We mock the generated daemon SDK (sdk.gen) the same way
 * `provider-create-form.test.tsx` does so the inline `ProviderCreateForm`
 * sub-form can run its create sequence without real network calls, and stub
 * its credential hooks so render doesn't fan out daemon queries.
 *
 * Coverage:
 *  - Name and Key live under the create flow's Advanced disclosure,
 *  - selecting a model pre-fills Name + Key from the model display name,
 *  - editing Name then selecting another model does NOT clobber Name/Key,
 *  - "+ Create new provider" mounts the inline ProviderCreateForm, and a
 *    successful create selects that provider + enables Save once a model is
 *    chosen,
 *  - every supported provider is offered, unconnected ones chipped with what
 *    they still need and routed into the inline create form preselected,
 *  - a rejected activation surfaces the server's own reason.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import type { ProviderConnection } from "@/generated/daemon/types.gen";
import * as sdkGen from "@/generated/daemon/sdk.gen";
import { ApiError } from "@/utils/api-errors";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let createdConnection: ProviderConnection;
let toastSuccessCalls: string[] = [];
const initialLifecycleState = useAssistantLifecycleStore.getState();

// Spy on the design-library toast so we can assert the shared ProfileEditorModal
// does NOT fire a profile-create success toast itself — that toast belongs to
// the surrounding surface (Settings via ProfileDetailPanel, composer via its
// own quick-add), preventing a double-fire.
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: (message: string) => {
      toastSuccessCalls.push(message);
    },
    error: () => {},
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  secretsPost: () =>
    Promise.resolve({ data: undefined, response: { ok: true } }),
  inferenceProviderconnectionsPost: () =>
    Promise.resolve({
      data: createdConnection,
      response: { ok: true, status: 200 },
    }),
}));

// Stub the credential hooks so the inline ProviderCreateForm renders without
// issuing real daemon queries.
mock.module("@/domains/settings/ai/use-stored-credential-presence", () => ({
  credentialPresenceQueryKey: (
    assistantId: string,
    kind: string,
    name: string,
  ) => ["credentialPresence", assistantId, kind, name] as const,
  useStoredCredentialPresence: () => ({
    hasStoredCredential: false,
    isLoading: false,
  }),
}));

mock.module("@/domains/settings/ai/use-provider-credentials-list", () => ({
  useProviderCredentialsList: () => ({
    credentials: [],
    isLoading: false,
  }),
}));

const { ProfileEditorModal } =
  await import("@/domains/settings/ai/profile-editor-modal");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSISTANT_ID = "asst-1";

function makeConnection(
  name: string,
  provider = "anthropic",
): ProviderConnection {
  return {
    name,
    label: null,
    provider,
    auth: { type: "api_key", credential: `credential/${provider}/api_key` },
    models: null,
  } as unknown as ProviderConnection;
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function getInputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = Array.from(
    document.querySelectorAll<HTMLInputElement>("input"),
  ).find((el) => el.placeholder === placeholder);
  if (!input) {
    throw new Error(`expected an input with placeholder "${placeholder}"`);
  }
  return input;
}

function getButton(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === label);
  if (!match) {
    throw new Error(`expected a "${label}" button`);
  }
  return match;
}

function getSaveBtn(): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(
    '[data-testid="modal-save-btn"]',
  );
  if (!btn) {
    throw new Error("expected a modal-save-btn");
  }
  return btn;
}

/** An option row's label, excluding any right-aligned suffix meta. */
function optionLabel(option: Element): string {
  return (
    option.querySelector(".truncate")?.textContent ??
    option.textContent ??
    ""
  ).trim();
}

/** Open the dropdown trigger and click the option whose label matches. */
function pickOption(trigger: HTMLButtonElement, wantedLabel: string): void {
  fireEvent.click(trigger);
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => optionLabel(o) === wantedLabel);
  if (!option) {
    throw new Error(
      `expected option "${wantedLabel}" — saw: ${Array.from(
        document.querySelectorAll('[role="option"]'),
      )
        .map((o) => `"${optionLabel(o)}"`)
        .join(", ")}`,
    );
  }
  fireEvent.click(option);
}

/**
 * The open listbox as `{ label, meta }` rows. `meta` is the right-aligned
 * suffix chip ("Managed", "Custom", "Add API key", …), empty when absent.
 */
function optionRows(): { label: string; meta: string }[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map((o) => {
    const label = optionLabel(o);
    const full = (o.textContent ?? "").trim();
    return { label, meta: full.slice(label.length).trim() };
  });
}

/** Labels of the open listbox, in order. */
function optionLabels(): string[] {
  return optionRows().map((row) => row.label);
}

/** Meta chip on supported-but-unconnected, key-based provider rows. */
const ADD_KEY_META = "Add API key";

/** Meta chip on a provider only a self-hosted assistant can reach. */
const SELF_HOSTED_ONLY_META = "Self-hosted only";

/** The open listbox's Ollama row. */
function ollamaOption(): HTMLElement {
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => optionLabel(o) === "Ollama");
  if (!option) {
    throw new Error("expected an Ollama option row");
  }
  return option;
}

/**
 * Every supported provider offered as an unconnected row, in picker order.
 * Custom endpoints are reached through "+ Create new provider", so they do not
 * appear here. Ollama is listed for every assistant; a platform-hosted one
 * sees it disabled with the self-hosted-only reason.
 */
const UNCONNECTED_PROVIDER_LABELS = [
  "Anthropic",
  "OpenAI",
  "Google Gemini",
  "Ollama",
  "Fireworks",
  "Together AI",
  "OpenRouter",
  "Vercel AI Gateway",
  "MiniMax",
  "Atlas Cloud",
  "LiteLLM",
  "OpenCode",
  "Baseten",
  "Poolside",
];

/** The create-mode Provider dropdown is labelled via `aria-labelledby`. */
function providerTrigger(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-labelledby="profile-editor-provider-label"]',
  );
  if (!trigger) {
    throw new Error("expected the Provider dropdown trigger");
  }
  return trigger;
}

/**
 * The inline ProviderCreateForm's own Provider dropdown (`aria-label`), or
 * null — the sub-form omits it when the outer picker preselected the provider.
 */
function createFormProviderTrigger(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label="Provider"]',
  );
}

/** Selects a provider in the create-mode Provider dropdown. */
function selectProvider(label: string): void {
  pickOption(providerTrigger(), label);
}

/**
 * The Model field. It is a filter input rather than a button trigger, which
 * is also what tells it apart from the Provider and Connection dropdowns.
 */
function modelField(): HTMLInputElement {
  const field = document.querySelector<HTMLInputElement>(
    'input[role="combobox"][aria-label="Model"]',
  );
  if (!field) {
    throw new Error("expected the Model field");
  }
  return field;
}

/** Focus opens the model list, the same way a pointer press on it does. */
function openModelList(): void {
  fireEvent.focus(modelField());
}

/** Labels of the open model list, in order. */
function modelOptionLabels(): string[] {
  openModelList();
  return optionLabels();
}

function selectModel(label: string): void {
  openModelList();
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => optionLabel(o) === label);
  if (!option) {
    throw new Error(
      `expected a Model list offering "${label}" - saw: ${optionLabels()
        .map((l) => `"${l}"`)
        .join(", ")}`,
    );
  }
  fireEvent.click(option);
}

function renderCreate(
  connections: ProviderConnection[],
  onSave: (name: string, entry: unknown) => Promise<void> = () =>
    Promise.resolve(),
  existingNames: string[] = [],
) {
  return render(
    <Wrapper>
      <ProfileEditorModal
        isOpen
        mode="create"
        existingNames={existingNames}
        connections={connections}
        assistantId={ASSISTANT_ID}
        onSave={onSave}
        onCancel={() => {}}
      />
    </Wrapper>,
  );
}

/** Render the editor in edit mode for an existing profile. */
function renderEdit(
  initialValues: Record<string, unknown>,
  onSave: (name: string, entry: unknown) => Promise<void> = () =>
    Promise.resolve(),
  connections: ProviderConnection[] = [makeConnection("anthropic-personal")],
) {
  return render(
    <Wrapper>
      <ProfileEditorModal
        isOpen
        mode="edit"
        profileName={(initialValues.name as string) ?? "balanced"}
        initialValues={initialValues as never}
        existingNames={[(initialValues.name as string) ?? "balanced"]}
        connections={connections}
        assistantId={ASSISTANT_ID}
        onSave={onSave}
        onCancel={() => {}}
      />
    </Wrapper>,
  );
}

/** Render the editor in view mode for a managed (platform-seeded) profile. */
function renderView(
  initialValues: Record<string, unknown>,
  onSave: (
    name: string,
    entry: unknown,
    options?: { mode?: "merge" | "replace" },
  ) => Promise<void> = () => Promise.resolve(),
) {
  return render(
    <Wrapper>
      <ProfileEditorModal
        isOpen
        mode="view"
        profileName={(initialValues.name as string) ?? "balanced"}
        initialValues={initialValues as never}
        existingNames={[(initialValues.name as string) ?? "balanced"]}
        connections={[makeConnection("anthropic-personal")]}
        assistantId={ASSISTANT_ID}
        onSave={onSave}
        onCancel={() => {}}
      />
    </Wrapper>,
  );
}

/** Finds a Toggle switch by its visible label (wired via aria-labelledby). */
function findSwitchByLabel(label: string): HTMLButtonElement | null {
  return (
    Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="switch"]'),
    ).find((el) => {
      const labelId = el.getAttribute("aria-labelledby");
      const labelEl = labelId ? document.getElementById(labelId) : null;
      return labelEl?.textContent?.trim() === label;
    }) ?? null
  );
}

/** The Top P toggle is a switch labelled (via aria-labelledby) "Top P". */
function topPSwitch(): HTMLButtonElement {
  const sw = findSwitchByLabel("Top P");
  if (!sw) {
    throw new Error("expected a Top P switch");
  }
  return sw;
}

/**
 * The Top P value slider, or null when absent. Its range is 0..1
 * (aria-valuemax "1"), which distinguishes it from temperature (0..2) and the
 * token sliders (large maxes).
 */
function findTopPSlider(): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[role="slider"]')).find(
      (el) => el.getAttribute("aria-valuemax") === "1",
    ) ?? null
  );
}

function topPSlider(): HTMLElement {
  const slider = findTopPSlider();
  if (!slider) {
    throw new Error("expected a Top P slider (aria-valuemax=1)");
  }
  return slider;
}

/**
 * Drive a provider-first create up to a Save-enabled state. Picking the model
 * fills the Name in, and the key follows the Name, so the two picks are the
 * whole form.
 */
function fillCreateForm(): void {
  selectProvider("Anthropic");
  selectModel("Claude Opus 4.8");
}

beforeEach(async () => {
  createdConnection = makeConnection("anthropic-personal");
  toastSuccessCalls = [];
  useAssistantLifecycleStore.setState(initialLifecycleState, true);
  // Seed a hydrated pre-gate version: the save path awaits
  // whenAssistantVersionKnown(), and an unhydrated store would stall each
  // save until that helper's timeout. Gate-on tests override per-test.
  const { useAssistantIdentityStore } =
    await import("@/stores/assistant-identity-store");
  useAssistantIdentityStore.getState().setIdentity("test-asst", "0.10.11");
});

afterEach(async () => {
  cleanup();
  const { useAssistantIdentityStore } =
    await import("@/stores/assistant-identity-store");
  useAssistantIdentityStore.getState().clearIdentity();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProfileEditorModal create mode — provider-first", () => {
  test("the create body asks only for Provider and Model; Name waits under Advanced", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    const nameField = () =>
      document.querySelector('input[placeholder="e.g. Claude Opus 4.8"]');

    // Nothing but the two questions the form is for.
    expect(nameField()).toBeNull();
    expect(document.body.textContent).not.toContain("Key");
    expect(findSwitchByLabel("Active")).toBeNull();

    selectProvider("Anthropic");
    selectModel("Claude Opus 4.8");

    // Advanced arrives collapsed, so the Name is still not in the body.
    expect(nameField()).toBeNull();

    fireEvent.click(getButton("Advanced"));

    expect(nameField()).not.toBeNull();
    // The Key is not a field any more, at any level of the form.
    expect(
      document.querySelector('input[placeholder="e.g. fast-cheap"]'),
    ).toBeNull();
  });

  test("Advanced is hidden until a model is chosen, then collapsed by default", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    expect(document.body.textContent).not.toContain("Pick a provider");

    // No model selected yet → the Advanced disclosure is not rendered.
    const hasAdvancedButton = () =>
      Array.from(document.querySelectorAll("button")).some(
        (b) => b.textContent?.trim() === "Advanced",
      );
    expect(hasAdvancedButton()).toBe(false);

    selectProvider("Anthropic");
    selectModel("Claude Opus 4.8");

    // Once a model is chosen the disclosure appears, collapsed.
    expect(hasAdvancedButton()).toBe(true);
    expect(getButton("Advanced").getAttribute("aria-expanded")).toBe("false");
  });

  test("selecting a model fills the Name in, and the key it derives", async () => {
    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    const onSave = (name: string, entry: unknown) => {
      saveCalls.push({ name, entry: entry as Record<string, unknown> });
      return Promise.resolve();
    };
    renderCreate([makeConnection("anthropic-personal")], onSave);

    selectProvider("Anthropic");
    selectModel("Claude Opus 4.8");
    fireEvent.click(getButton("Advanced"));

    expect(getInputByPlaceholder("e.g. Claude Opus 4.8").value).toBe(
      "Claude Opus 4.8",
    );

    // The key is never shown, so it is asserted where it surfaces: the name
    // the profile is saved under.
    fireEvent.click(getSaveBtn());
    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].name).toBe("claude-opus-4-8");
    expect(saveCalls[0].entry.label).toBe("Claude Opus 4.8");
  });

  test("a model whose name is taken gains a numeric suffix", async () => {
    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    const onSave = (name: string, entry: unknown) => {
      saveCalls.push({ name, entry: entry as Record<string, unknown> });
      return Promise.resolve();
    };
    renderCreate([makeConnection("anthropic-personal")], onSave, [
      "claude-opus-4-8",
    ]);

    selectProvider("Anthropic");
    selectModel("Claude Opus 4.8");
    fireEvent.click(getButton("Advanced"));

    expect(getInputByPlaceholder("e.g. Claude Opus 4.8").value).toBe(
      "Claude Opus 4.8 (2)",
    );

    fireEvent.click(getSaveBtn());
    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].name).toBe("claude-opus-4-8-2");
  });

  test("a hand-typed duplicate Name gains the suffix on blur", () => {
    renderCreate([makeConnection("anthropic-personal")], undefined, [
      "claude-opus-4-8",
    ]);

    selectProvider("Anthropic");
    selectModel("Claude Opus 4.7");
    fireEvent.click(getButton("Advanced"));

    const name = getInputByPlaceholder("e.g. Claude Opus 4.8");
    fireEvent.change(name, { target: { value: "Claude Opus 4.8" } });
    expect(name.value).toBe("Claude Opus 4.8");

    fireEvent.blur(name);
    expect(getInputByPlaceholder("e.g. Claude Opus 4.8").value).toBe(
      "Claude Opus 4.8 (2)",
    );
  });

  test("editing Name stops model-driven pre-fill from overwriting", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    selectProvider("Anthropic");
    selectModel("Claude Opus 4.8");
    fireEvent.click(getButton("Advanced"));

    // User overrides the Name.
    fireEvent.change(getInputByPlaceholder("e.g. Claude Opus 4.8"), {
      target: { value: "My Custom Profile" },
    });

    // Selecting a different model must NOT clobber the manual Name.
    selectModel("Claude Opus 4.7");

    expect(getInputByPlaceholder("e.g. Claude Opus 4.8").value).toBe(
      "My Custom Profile",
    );
  });

  test("first-run empty state offers every supported provider, each flagged as needing a key", () => {
    // Nothing is connected yet, so every supported provider is listed as a
    // "connect me" entry — a supported provider must never be invisible just
    // because no connection exists for it (Google Gemini, in the report).
    renderCreate([]);
    fireEvent.click(providerTrigger());
    expect(optionLabels()).toEqual([
      ...UNCONNECTED_PROVIDER_LABELS,
      "+ Create new provider",
    ]);
    expect(optionLabels()).toContain("Google Gemini");
    // Each connectable one carries the chip naming what it still needs, while
    // Ollama names why this assistant cannot reach it at all.
    expect(
      optionRows()
        .filter(
          (row) =>
            row.label !== "+ Create new provider" && row.label !== "Ollama",
        )
        .every((row) => row.meta === ADD_KEY_META),
    ).toBe(true);
    expect(optionRows()).toContainEqual({
      label: "Ollama",
      meta: SELF_HOSTED_ONLY_META,
    });
  });

  test("the Vellum-managed connection leads, with the unconnected providers behind it", () => {
    // A platform-hosted user's only connection is the single provider-agnostic
    // `vellum` connection. It leads the list as one entry (never the managed
    // upstreams it routes to); BYOK providers follow as connect-me entries.
    renderCreate([makeConnection("vellum-managed", "vellum")]);
    fireEvent.click(providerTrigger());
    expect(optionRows()[0]).toEqual({ label: "Vellum", meta: "Managed" });
    expect(optionLabels()).toEqual([
      "Vellum",
      ...UNCONNECTED_PROVIDER_LABELS,
      "+ Create new provider",
    ]);
  });

  test("selecting Vellum saves the model's managed upstream bound to the vellum connection", async () => {
    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    const onSave = (name: string, entry: unknown) => {
      saveCalls.push({ name, entry: entry as Record<string, unknown> });
      return Promise.resolve();
    };
    renderCreate([makeConnection("vellum-managed", "vellum")], onSave);

    selectProvider("Vellum");
    selectModel("Claude Opus 4.8");

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());

    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    // Legacy wire shape: upstream derived from the model, vellum binding.
    expect(saveCalls[0].entry.provider).toBe("anthropic");
    expect(saveCalls[0].entry.provider_connection).toBe("vellum-managed");
  });

  test("a Vellum fireworks-hosted model derives the fireworks upstream", async () => {
    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    const onSave = (name: string, entry: unknown) => {
      saveCalls.push({ name, entry: entry as Record<string, unknown> });
      return Promise.resolve();
    };
    renderCreate([makeConnection("vellum-managed", "vellum")], onSave);

    selectProvider("Vellum");
    selectModel("GLM 5.2");

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());

    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.provider).toBe("fireworks");
    expect(saveCalls[0].entry.provider_connection).toBe("vellum-managed");
  });

  test("catalog providers show no connection field, even with multiple keys", async () => {
    renderCreate([
      makeConnection("anthropic-personal"),
      makeConnection("anthropic-personal-2"),
    ]);
    selectProvider("Anthropic");
    expect(document.body.textContent).not.toContain("Connection");
    expect(document.body.textContent).not.toContain("Endpoint");
  });

  test("each openai-compatible endpoint is its own provider entry", async () => {
    const lmStudio = {
      ...makeConnection("lm-studio", "openai-compatible"),
      models: [{ id: "model-1", displayName: "Model 1" }],
    } as unknown as ProviderConnection;
    const vllmBox = {
      ...makeConnection("vllm-box", "openai-compatible"),
      models: [{ id: "model-2", displayName: "Model 2" }],
    } as unknown as ProviderConnection;
    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    const onSave = (name: string, entry: unknown) => {
      saveCalls.push({ name, entry: entry as Record<string, unknown> });
      return Promise.resolve();
    };
    renderCreate([lmStudio, vllmBox], onSave);

    // Both endpoints are individual entries; no generic collapsed entry and
    // no second field.
    fireEvent.click(providerTrigger());
    expect(optionRows().slice(0, 2)).toEqual([
      { label: "lm-studio", meta: "Custom" },
      { label: "vllm-box", meta: "Custom" },
    ]);
    // The unconnected providers follow, and the create entry still closes the
    // list — "OpenAI-compatible" is never offered as a bare protocol entry.
    expect(optionLabels()).toEqual([
      "lm-studio",
      "vllm-box",
      ...UNCONNECTED_PROVIDER_LABELS,
      "+ Create new provider",
    ]);
    fireEvent.click(
      Array.from(
        document.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((o) => optionLabel(o) === "lm-studio")!,
    );
    expect(document.body.textContent).not.toContain("Endpoint");
    expect(document.body.textContent).not.toContain("Connection (optional)");

    selectModel("Model 1");
    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());
    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    // The endpoint entry implies the provider plus its binding on the wire.
    expect(saveCalls[0].entry.provider).toBe("openai-compatible");
    expect(saveCalls[0].entry.provider_connection).toBe("lm-studio");
    expect(saveCalls[0].entry.model).toBe("model-1");
  });

  test("a new-enough assistant gets the identity payload: provider vellum, no binding", async () => {
    const { useAssistantIdentityStore } =
      await import("@/stores/assistant-identity-store");
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-asst", "0.10.12", ASSISTANT_ID);
    try {
      const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
      const onSave = (name: string, entry: unknown) => {
        saveCalls.push({ name, entry: entry as Record<string, unknown> });
        return Promise.resolve();
      };
      renderCreate([makeConnection("vellum-managed", "vellum")], onSave);

      selectProvider("Vellum");
      selectModel("Claude Opus 4.8");

      await waitFor(() => {
        expect(getSaveBtn().disabled).toBe(false);
      });
      fireEvent.click(getSaveBtn());

      await waitFor(() => {
        expect(saveCalls.length).toBe(1);
      });
      expect(saveCalls[0].entry.provider).toBe("vellum");
      expect(saveCalls[0].entry.model).toBe("claude-opus-4-8");
      expect(saveCalls[0].entry.provider_connection).toBeUndefined();
    } finally {
      useAssistantIdentityStore.getState().clearIdentity();
    }
  });

  test("an older assistant keeps the legacy payload byte-identical", async () => {
    const { useAssistantIdentityStore } =
      await import("@/stores/assistant-identity-store");
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.10.11");
    try {
      const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
      const onSave = (name: string, entry: unknown) => {
        saveCalls.push({ name, entry: entry as Record<string, unknown> });
        return Promise.resolve();
      };
      renderCreate([makeConnection("vellum-managed", "vellum")], onSave);

      selectProvider("Vellum");
      selectModel("Claude Opus 4.8");

      await waitFor(() => {
        expect(getSaveBtn().disabled).toBe(false);
      });
      fireEvent.click(getSaveBtn());

      await waitFor(() => {
        expect(saveCalls.length).toBe(1);
      });
      expect(saveCalls[0].entry.provider).toBe("anthropic");
      expect(saveCalls[0].entry.model).toBe("claude-opus-4-8");
      expect(saveCalls[0].entry.provider_connection).toBe("vellum-managed");
    } finally {
      useAssistantIdentityStore.getState().clearIdentity();
    }
  });

  test("an unbound openai-compatible profile keeps its provider label in edit mode", async () => {
    render(
      <Wrapper>
        <ProfileEditorModal
          isOpen
          mode="edit"
          profileName="my-local"
          initialValues={
            {
              name: "my-local",
              provider: "openai-compatible",
              model: "my-model",
            } as never
          }
          existingNames={["my-local"]}
          connections={[
            {
              ...makeConnection("lm-studio", "openai-compatible"),
              models: [{ id: "my-model" }],
            },
            {
              ...makeConnection("vllm-box", "openai-compatible"),
              models: [{ id: "other-model" }],
            },
          ]}
          assistantId={ASSISTANT_ID}
          onSave={() => Promise.resolve()}
          onCancel={() => {}}
        />
      </Wrapper>,
    );

    // No endpoint entry matches the unbound state; the bare protocol value
    // keeps the trigger labeled instead of falling to the placeholder.
    await waitFor(() => {
      expect(providerTrigger().textContent?.trim()).toBe("OpenAI-compatible");
    });
  });

  test("a legacy-shape managed profile presents as Vellum in edit mode", async () => {
    // Managed profiles store their real upstream (anthropic) bound to the
    // vellum connection; the editor must present them as "Vellum".
    render(
      <Wrapper>
        <ProfileEditorModal
          isOpen
          mode="edit"
          profileName="my-managed"
          initialValues={
            {
              name: "my-managed",
              provider: "anthropic",
              model: "claude-opus-4-8",
              provider_connection: "vellum",
            } as never
          }
          existingNames={["my-managed"]}
          connections={[makeConnection("vellum", "vellum")]}
          assistantId={ASSISTANT_ID}
          onSave={() => Promise.resolve()}
          onCancel={() => {}}
        />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(optionLabel(providerTrigger())).toBe("Vellum");
    });
    expect(document.body.textContent).not.toContain("Connection (optional)");
  });

  test("editing a Vellum profile with a catalog-unknown model preserves the stored upstream", async () => {
    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    const onSave = (name: string, entry: unknown) => {
      saveCalls.push({ name, entry: entry as Record<string, unknown> });
      return Promise.resolve();
    };
    render(
      <Wrapper>
        <ProfileEditorModal
          isOpen
          mode="edit"
          profileName="my-managed"
          initialValues={
            {
              name: "my-managed",
              provider: "fireworks",
              model: "accounts/fireworks/models/some-future-model",
              provider_connection: "vellum",
            } as never
          }
          existingNames={["my-managed"]}
          connections={[makeConnection("vellum", "vellum")]}
          assistantId={ASSISTANT_ID}
          onSave={onSave}
          onCancel={() => {}}
        />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());

    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    // A harmless save must not clear the stored upstream.
    expect(saveCalls[0].entry.provider).toBe("fireworks");
    expect(saveCalls[0].entry.provider_connection).toBe("vellum");
  });

  test("a user-owned connection merely named 'vellum' does not trigger Vellum mode", async () => {
    // The daemon's seeder preserves a user row named "vellum" whose provider
    // is not the sentinel; editing a profile bound to it must keep the real
    // provider and not corrupt the binding.
    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    const onSave = (name: string, entry: unknown) => {
      saveCalls.push({ name, entry: entry as Record<string, unknown> });
      return Promise.resolve();
    };
    render(
      <Wrapper>
        <ProfileEditorModal
          isOpen
          mode="edit"
          profileName="my-local"
          initialValues={
            {
              name: "my-local",
              provider: "openai-compatible",
              model: "my-model",
              provider_connection: "vellum",
            } as never
          }
          existingNames={["my-local"]}
          connections={[
            {
              ...makeConnection("vellum", "openai-compatible"),
              models: [{ id: "my-model" }],
            },
          ]}
          assistantId={ASSISTANT_ID}
          onSave={onSave}
          onCancel={() => {}}
        />
      </Wrapper>,
    );

    // The trigger renders the ENDPOINT entry (labeled by the row name) —
    // not Vellum picker mode; the wire payload proves the distinction.
    await waitFor(() => {
      expect(optionLabel(providerTrigger())).toBe("vellum");
    });

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());
    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.provider).toBe("openai-compatible");
    expect(saveCalls[0].entry.provider_connection).toBe("vellum");
  });

  test("a routed model string is stripped to the upstream's native id on save", async () => {
    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    const onSave = (name: string, entry: unknown) => {
      saveCalls.push({ name, entry: entry as Record<string, unknown> });
      return Promise.resolve();
    };
    render(
      <Wrapper>
        <ProfileEditorModal
          isOpen
          mode="edit"
          profileName="my-managed"
          initialValues={
            {
              name: "my-managed",
              provider: "fireworks",
              model: "fireworks/accounts/fireworks/models/kimi-k2p5",
              provider_connection: "vellum",
            } as never
          }
          existingNames={["my-managed"]}
          connections={[makeConnection("vellum", "vellum")]}
          assistantId={ASSISTANT_ID}
          onSave={onSave}
          onCancel={() => {}}
        />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());
    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.provider).toBe("fireworks");
    expect(saveCalls[0].entry.model).toBe(
      "accounts/fireworks/models/kimi-k2p5",
    );
    expect(saveCalls[0].entry.provider_connection).toBe("vellum");
  });

  test("a routed model resolves advanced controls from its native id", async () => {
    // Visibility heuristics expect native ids; a routed string must not hide
    // the upstream's controls (a replace-mode save would then clear them).
    render(
      <Wrapper>
        <ProfileEditorModal
          isOpen
          mode="edit"
          profileName="my-managed"
          initialValues={
            {
              name: "my-managed",
              provider: "openai",
              model: "openai/gpt-5.5",
              provider_connection: "vellum",
              effort: "high",
            } as never
          }
          existingNames={["my-managed"]}
          connections={[makeConnection("vellum", "vellum")]}
          assistantId={ASSISTANT_ID}
          onSave={() => Promise.resolve()}
          onCancel={() => {}}
        />
      </Wrapper>,
    );

    // gpt-5.5's controls include Verbosity (an openai-family field) — it
    // only renders when visibility resolved against the native id.
    await waitFor(() => {
      expect(document.body.textContent).toContain("Verbosity");
    });
  });

  test("Vellum hides the Connection sub-dropdown", () => {
    renderCreate([makeConnection("vellum-managed", "vellum")]);
    selectProvider("Vellum");
    expect(document.body.textContent).not.toContain("Connection (optional)");
    expect(
      Array.from(document.querySelectorAll("label")).some((l) =>
        l.textContent?.trim().startsWith("Connection"),
      ),
    ).toBe(false);
  });

  test("a BYOK connection surfaces its own provider, unchipped and listed once", () => {
    // A self-hosted user who entered an Anthropic API key gets an `anthropic`
    // connection, which must surface Anthropic as a ready-to-use provider —
    // leading the list, with no "needs a key" chip and no duplicate entry in
    // the unconnected tail.
    renderCreate([makeConnection("anthropic-personal", "anthropic")]);
    fireEvent.click(providerTrigger());
    expect(optionRows()[0]).toEqual({ label: "Anthropic", meta: "" });
    expect(optionLabels().filter((l) => l === "Anthropic")).toHaveLength(1);
    expect(optionLabels()).toEqual([
      "Anthropic",
      ...UNCONNECTED_PROVIDER_LABELS.filter((l) => l !== "Anthropic"),
      "+ Create new provider",
    ]);
  });

  test("a provider unknown to the catalog shows an explicit empty-model state", () => {
    // "acme-llm" isn't in the static web catalog — `getModelsForProvider`
    // returns [] for unknown ids — reproducing the drift scenario where a
    // connection exists for a provider this app version doesn't know about.
    renderCreate([makeConnection("acme-llm-personal", "acme-llm")]);

    selectProvider("acme-llm");

    // The Model field explains the empty list instead of showing a bare
    // "Select a model" placeholder over zero options...
    expect(modelField().placeholder).toBe("No models available");

    // ...and the hint below spells out why and what to do about it.
    expect(document.body.textContent).toContain(
      "No models are available for this provider in this app version. " +
        "Update the app, or enter a custom model ID.",
    );
  });

  test("Ollama connections offer the bundled local models", () => {
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "self_hosted" },
    });
    renderCreate([makeConnection("ollama", "ollama")]);

    selectProvider("Ollama");

    expect(modelField().placeholder).toBe("Select a model");

    selectModel("Llama 3.2");
    fireEvent.click(getButton("Advanced"));
    expect(getInputByPlaceholder("e.g. Claude Opus 4.8").value).toBe("Llama 3.2");

    // A Name the editor filled in itself follows the next model pick.
    selectModel("Mistral");
    expect(getInputByPlaceholder("e.g. Claude Opus 4.8").value).toBe("Mistral");
  });

  test("platform-hosted assistants offer Ollama disabled with the reason", () => {
    // Hiding it entirely reads as missing support; the row states the
    // restriction instead and refuses selection.
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "active", isLocal: false },
    });
    renderCreate([makeConnection("ollama", "ollama")]);

    fireEvent.click(providerTrigger());

    expect(optionRows()).toContainEqual({
      label: "Ollama",
      meta: SELF_HOSTED_ONLY_META,
    });
    const ollama = ollamaOption();
    expect(ollama.getAttribute("aria-disabled")).toBe("true");
    expect(ollama.getAttribute("data-disabled")).not.toBeNull();

    // Clicking it leaves the picker on its original selection.
    const before = providerTrigger().textContent;
    fireEvent.click(ollama);
    expect(providerTrigger().textContent).toBe(before);
  });

  test("a self-hosted assistant offers unconnected Ollama as a keyless set-up entry", () => {
    // Ollama serves a local endpoint with no credential, so its chip must not
    // promise an API key step it never asks for.
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "self_hosted" },
    });
    renderCreate([]);

    fireEvent.click(providerTrigger());

    expect(optionRows()).toContainEqual({ label: "Ollama", meta: "Set up" });
  });

  test("+ Create new provider mounts ProviderCreateForm; successful create selects it and Save enables after a model", async () => {
    renderCreate([]);

    selectProvider("+ Create new provider");

    // Inline ProviderCreateForm is mounted; auth derives from the provider
    // (anthropic → api_key), so entering a key is the whole flow.
    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "sk-test-123" },
    });
    fireEvent.click(getButton("Add"));

    // After create, the sub-form collapses and the provider is selected.
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "New provider connection will show up in the Providers section.",
      );
    });

    // Save is still blocked until a model is chosen.
    expect(getSaveBtn().disabled).toBe(true);

    selectModel("Claude Opus 4.8");

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
  });

  test("picking an unconnected provider opens the inline create form preselected on it", () => {
    renderCreate([makeConnection("anthropic-personal", "anthropic")]);

    selectProvider("Google Gemini");

    // The sub-form is mounted with Gemini already fixed, so the user lands
    // directly on the API-key field with no second Provider dropdown — the
    // outer picker is the single place the provider reads.
    expect(createFormProviderTrigger()).toBeNull();
    expect(getInputByPlaceholder("Enter your API key")).toBeDefined();
    expect(optionLabel(providerTrigger())).toBe("Google Gemini");
  });

  test("switching to another unconnected provider re-seeds the inline create form", () => {
    renderCreate([]);

    selectProvider("Google Gemini");
    // Gemini's credential ref is seeded into the remounted sub-form.
    expect(getInputByPlaceholder("Enter your API key")).toBeDefined();
    expect(optionLabel(providerTrigger())).toBe("Google Gemini");

    selectProvider("OpenRouter");
    expect(getInputByPlaceholder("Enter your API key")).toBeDefined();
    expect(optionLabel(providerTrigger())).toBe("OpenRouter");
  });

  test("the generic create-new-provider entry keeps the sub-form's own Provider dropdown", () => {
    renderCreate([]);

    selectProvider("+ Create new provider");

    const trigger = createFormProviderTrigger();
    expect(trigger).not.toBeNull();
  });

  test("connecting a preselected provider binds it and continues the profile flow", async () => {
    createdConnection = makeConnection("gemini", "gemini");
    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    const onSave = (name: string, entry: unknown) => {
      saveCalls.push({ name, entry: entry as Record<string, unknown> });
      return Promise.resolve();
    };
    renderCreate([], onSave);

    selectProvider("Google Gemini");
    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "test-key-123" },
    });
    fireEvent.click(getButton("Add"));

    // The sub-form collapses and the new connection is bound to the profile.
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "New provider connection will show up in the Providers section.",
      );
    });

    selectModel("Gemini 3.6 Flash");
    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());

    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.provider).toBe("gemini");
    expect(saveCalls[0].entry.provider_connection).toBe("gemini");
  });

  test("cancelling the inline create leaves the profile without a provider", () => {
    renderCreate([]);

    selectProvider("Google Gemini");
    // The sub-form's own Cancel, not the modal footer's.
    const inlineCancel = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find(
      (b) =>
        b.textContent?.trim() === "Cancel" &&
        b.getAttribute("data-testid") !== "modal-cancel-btn",
    );
    fireEvent.click(inlineCancel!);

    // No connection was created, so the profile must not be left bound to a
    // route the daemon can't dispatch through — Save stays blocked.
    expect(getSaveBtn().disabled).toBe(true);
    expect(providerTrigger().textContent?.trim()).toBe("Select a provider…");
  });

  test("a connected provider is selected directly, without the create form", () => {
    renderCreate([makeConnection("anthropic-personal", "anthropic")]);

    selectProvider("Anthropic");

    expect(
      document.querySelector('input[placeholder="Enter your API key"]'),
    ).toBeNull();
    selectModel("Claude Opus 4.8");
    expect(optionLabel(providerTrigger())).toBe("Anthropic");
  });

  test("inline-create then immediate save persists the new provider_connection (no race)", async () => {
    // Regression: before the optimistic local-connection merge, saving in the
    // window between inline create and the parent connections refetch left
    // `connectionNotFound` true, so the save handler dropped the binding to "".
    createdConnection = makeConnection("anthropic-personal");

    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    const onSave = (name: string, entry: unknown) => {
      saveCalls.push({ name, entry: entry as Record<string, unknown> });
      return Promise.resolve();
    };

    // Start with zero connections so the only Provider option is "+ Create
    // new provider" and the parent prop never refetches in this test (the
    // binding must be valid purely from the optimistic local merge).
    renderCreate([], onSave);

    selectProvider("+ Create new provider");
    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "sk-test-123" },
    });
    fireEvent.click(getButton("Add"));

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "New provider connection will show up in the Providers section.",
      );
    });

    // Pick a model, then save immediately (no connections refetch).
    selectModel("Claude Opus 4.8");

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());

    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.provider).toBe("anthropic");
    expect(saveCalls[0].entry.provider_connection).toBe("anthropic-personal");
  });

  test("Save shows 'Saving…' and disables while the create is in flight", async () => {
    // Hold the save promise open so we can observe the in-flight state.
    let resolveSave: () => void = () => {};
    const onSave = () =>
      new Promise<void>((resolve) => {
        resolveSave = resolve;
      });

    renderCreate([makeConnection("anthropic-personal")], onSave);
    fillCreateForm();

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());

    // While pending: button is disabled and shows progress text.
    await waitFor(() => {
      expect(getSaveBtn().textContent?.trim()).toBe("Saving…");
    });
    expect(getSaveBtn().disabled).toBe(true);

    resolveSave();
    await waitFor(() => {
      expect(getSaveBtn().textContent?.trim()).toBe("Save");
    });
  });

  test("a save failure renders inline and keeps the modal open", async () => {
    const onSave = () => Promise.reject(new Error("invalid API key"));

    renderCreate([makeConnection("anthropic-personal")], onSave);
    fillCreateForm();

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());

    // The inline error surfaces...
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Failed to save profile. Please try again.",
      );
    });
    // ...and the modal stays open (the Save button is still rendered).
    expect(getSaveBtn()).toBeDefined();
  });

  test("the modal itself does NOT fire a profile-create success toast", async () => {
    // The success toast belongs to the surrounding surface (Settings/composer),
    // not the shared modal — this guards against a double-fire regression.
    let resolved = false;
    const onSave = () => {
      resolved = true;
      return Promise.resolve();
    };

    renderCreate([makeConnection("anthropic-personal")], onSave);
    fillCreateForm();

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());

    await waitFor(() => {
      expect(resolved).toBe(true);
    });
    expect(toastSuccessCalls).toEqual([]);
  });

  test('saving Fireworks DeepSeek V4 Flash with effort "none" persists the explicit opt-out', async () => {
    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    const onSave = (name: string, entry: unknown) => {
      saveCalls.push({ name, entry: entry as Record<string, unknown> });
      return Promise.resolve();
    };

    renderCreate([makeConnection("fireworks-managed", "fireworks")], onSave);

    selectProvider("Fireworks");
    selectModel("DeepSeek V4 Flash");
    fireEvent.click(getButton("Advanced"));
    fireEvent.click(getButton("none"));

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());

    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.effort).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Edit mode — a bound model that isn't in the static catalog (JARVIS-1180)
// ---------------------------------------------------------------------------

describe("ProfileEditorModal edit mode — catalog-absent bound model", () => {
  function renderEdit(
    initialValues: Record<string, unknown>,
    connection: ProviderConnection,
  ) {
    return render(
      <Wrapper>
        <ProfileEditorModal
          isOpen
          mode="edit"
          profileName={initialValues.name as string}
          initialValues={initialValues as unknown as never}
          existingNames={[initialValues.name as string]}
          connections={[connection]}
          assistantId={ASSISTANT_ID}
          onSave={() => Promise.resolve()}
          onCancel={() => {}}
        />
      </Wrapper>,
    );
  }

  test("renders the bound OpenRouter model (raw-id fallback) instead of an empty picker, and keeps Save enabled", () => {
    // Reproduces JARVIS-1180: the "Fusion" profile is bound to an OpenRouter
    // model id that isn't in this build's static catalog (it connects in Chat,
    // which dispatches the id straight to OpenRouter). The editor used to show
    // the empty "Select a model" placeholder, drop the binding via auto-clear,
    // and block Save with a validation error.
    renderEdit(
      {
        name: "fusion",
        label: "Fusion",
        provider: "openrouter",
        model: "openrouter/fusion",
        provider_connection: "openrouter",
        status: "active",
      },
      makeConnection("openrouter", "openrouter"),
    );

    // The Model field surfaces the bound id (no catalog/connection name
    // available, so it falls back to the raw id) rather than the empty
    // placeholder...
    expect(modelField().value).toBe("openrouter/fusion");

    // ...the bound model isn't auto-cleared, so the validation hint stays away
    // and Save remains enabled (the binding would persist intact).
    expect(document.body.textContent).not.toContain("Select a model.");
    expect(getSaveBtn().disabled).toBe(false);
  });

  test("treats the vellum connection as available for a managed-routable provider (no stale-clear)", () => {
    // A managed profile keeps its real provider (fireworks) but binds to the
    // provider-agnostic `vellum` connection, whose own provider is the `vellum`
    // sentinel. The editor must recognize that binding for managed-routable
    // providers instead of flagging it "not found" and auto-clearing it on save.
    renderEdit(
      {
        name: "balanced",
        label: "Balanced",
        provider: "fireworks",
        model: "accounts/fireworks/models/kimi-k2p5",
        provider_connection: "vellum",
        status: "active",
      },
      makeConnection("vellum", "vellum"),
    );

    // The binding resolves — the stale "(not found)" marker is absent.
    expect(document.body.textContent).not.toContain("vellum (not found)");
    expect(getSaveBtn().disabled).toBe(false);
  });

  test("offers the bound model as a selectable option in the Model dropdown", () => {
    renderEdit(
      {
        name: "fusion",
        label: "Fusion",
        provider: "openrouter",
        model: "openrouter/fusion",
        provider_connection: "openrouter",
        status: "active",
      },
      makeConnection("openrouter", "openrouter"),
    );

    // The Model list must offer the bound id so it can be re-selected
    // manually (the second reported surface of JARVIS-1180).
    expect(modelOptionLabels()).toContain("openrouter/fusion");
  });

  test("renders a bound openai-compatible model the connection list omits, and keeps Save enabled", () => {
    // An openai-compatible profile can be bound to a pass-through id
    // (gateway alias, unrefreshed model) that the connection's returned
    // list does not include. The Model field still shows that id, and
    // Save stays enabled.
    const lmStudio = {
      ...makeConnection("lm-studio", "openai-compatible"),
      models: [{ id: "llama-3.1", displayName: "Llama 3.1" }],
    } as unknown as ProviderConnection;

    renderEdit(
      {
        name: "local-llm",
        label: "Local LLM",
        provider: "openai-compatible",
        model: "gateway-alias",
        provider_connection: "lm-studio",
        status: "active",
      },
      lmStudio,
    );

    expect(modelField().value).toBe("gateway-alias");
    expect(document.body.textContent).not.toContain("Select a model.");
    expect(getSaveBtn().disabled).toBe(false);
  });

  test("clears a catalog model the connection's subscription filters out, rather than offering it", async () => {
    // A ChatGPT-subscription OpenAI connection only accepts the Codex-compatible
    // model set, so a profile pinned to an in-catalog but non-Codex model
    // (gpt-5.5-pro) is a known-incompatible binding: the editor clears it rather
    // than presenting it as a valid, saveable choice.
    const subscriptionConnection = {
      name: "openai-chatgpt",
      label: null,
      provider: "openai",
      auth: {
        type: "oauth_subscription",
        credential: "credential/openai/oauth_subscription",
      },
      models: null,
    } as unknown as ProviderConnection;

    renderEdit(
      {
        name: "codex",
        label: "Codex",
        provider: "openai",
        model: "gpt-5.5-pro",
        provider_connection: "openai-chatgpt",
        status: "active",
      },
      subscriptionConnection,
    );

    // The incompatible model is auto-cleared: the Model field falls back to
    // its placeholder and never surfaces "GPT-5.5 Pro".
    await waitFor(() => {
      expect(modelField().value).toBe("");
    });
    expect(modelField().placeholder).toBe("Select a model");

    // The list offers the Codex-compatible models but not the filtered one.
    const optionLabels = modelOptionLabels();
    expect(optionLabels).toContain("GPT-5.6 Sol");
    expect(optionLabels).toContain("GPT-5.6 Terra");
    expect(optionLabels).toContain("GPT-5.6 Luna");
    expect(optionLabels).toContain("GPT-5.5");
    expect(optionLabels).not.toContain("GPT-5.5 Pro");
  });

  test("lets the user enter a custom model ID the catalog omits and saves it verbatim", async () => {
    // The static OpenRouter catalog can't track every routable model, so the
    // Model field offers a free-text escape hatch. Picking it and typing an id
    // the build doesn't list must produce a saveable profile bound to that id.

    // GIVEN an OpenRouter profile open in the editor, bound to a catalog model
    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    render(
      <Wrapper>
        <ProfileEditorModal
          isOpen
          mode="edit"
          profileName="fusion"
          initialValues={
            {
              name: "fusion",
              label: "Fusion",
              provider: "openrouter",
              model: "anthropic/claude-opus-4.8",
              provider_connection: "openrouter",
              status: "active",
            } as unknown as never
          }
          existingNames={["fusion"]}
          connections={[makeConnection("openrouter", "openrouter")]}
          assistantId={ASSISTANT_ID}
          onSave={(name, entry) => {
            saveCalls.push({ name, entry: entry as Record<string, unknown> });
            return Promise.resolve();
          }}
          onCancel={() => {}}
        />
      </Wrapper>,
    );

    // WHEN the user picks the free-text option and types an id absent from
    // the catalog, then saves
    selectModel("Enter a custom model ID…");

    const modelInput = getInputByPlaceholder("provider/model-id");
    fireEvent.change(modelInput, { target: { value: "tencent/hy3" } });

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());

    // THEN the typed id is persisted exactly as entered
    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.model).toBe("tencent/hy3");
  });

  test("withholds the custom-model option from a subscription-restricted connection", () => {
    // A ChatGPT-subscription OpenAI connection only accepts the Codex model
    // set, so the free-text escape hatch must not appear — a typed id the
    // endpoint rejects would otherwise be saveable.
    const subscriptionConnection = {
      name: "openai-chatgpt",
      label: null,
      provider: "openai",
      auth: {
        type: "oauth_subscription",
        credential: "credential/openai/oauth_subscription",
      },
      models: null,
    } as unknown as ProviderConnection;

    renderEdit(
      {
        name: "codex",
        label: "Codex",
        provider: "openai",
        model: "gpt-5.5",
        provider_connection: "openai-chatgpt",
        status: "active",
      },
      subscriptionConnection,
    );

    const optionLabels = modelOptionLabels();
    expect(optionLabels).toContain("GPT-5.5");
    expect(optionLabels).not.toContain("Enter a custom model ID…");
  });
});

describe("ProfileEditorModal — Top P wiring", () => {
  // Anthropic opus → visibility.topP is true, so the control renders.
  const balancedProfile = {
    name: "balanced",
    label: "Balanced",
    provider: "anthropic",
    model: "claude-opus-4-8",
    topP: 0.9,
  };

  test("opens a profile with topP showing the toggle on at that value", () => {
    renderEdit(balancedProfile);

    expect(topPSwitch().getAttribute("aria-checked")).toBe("true");
    expect(topPSlider().getAttribute("aria-valuenow")).toBe("0.9");
  });

  test("a profile without topP shows the toggle off and no slider", () => {
    renderEdit({ ...balancedProfile, topP: undefined });

    expect(topPSwitch().getAttribute("aria-checked")).toBe("false");
    expect(findTopPSlider()).toBeNull();
  });

  test("saving with Top P enabled submits topP as a number", async () => {
    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    const onSave = (name: string, entry: unknown) => {
      saveCalls.push({ name, entry: entry as Record<string, unknown> });
      return Promise.resolve();
    };

    renderEdit(balancedProfile, onSave);

    fireEvent.click(getSaveBtn());

    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.topP).toBe(0.9);
    expect(typeof saveCalls[0].entry.topP).toBe("number");
  });

  test("disabling Top P in edit mode submits topP: null", async () => {
    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    const onSave = (name: string, entry: unknown) => {
      saveCalls.push({ name, entry: entry as Record<string, unknown> });
      return Promise.resolve();
    };

    renderEdit(balancedProfile, onSave);

    // Toggle Top P off, then save — edit mode clears it explicitly with null.
    fireEvent.click(topPSwitch());
    fireEvent.click(getSaveBtn());

    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.topP).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Invariant (managed) profiles — server-stamped `invariant: true`
// ---------------------------------------------------------------------------

describe("ProfileEditorModal — invariant managed profiles in view mode", () => {
  // A server-stamped managed profile. Anthropic opus → visibility.topP is
  // true, so the Top P control renders and we can assert it is locked.
  const invariantProfile = {
    name: "default-a",
    label: "Default A",
    provider: "anthropic",
    model: "claude-opus-4-8",
    source: "managed",
    invariant: true,
    topP: 0.9,
  };

  test("an active invariant profile is fully read-only: no status toggle, disabled label and Top P, Save never armed", () => {
    renderView(invariantProfile);

    // No disable affordance: the Active toggle is not rendered at all.
    expect(findSwitchByLabel("Active")).toBeNull();

    // Label and Top P are locked.
    expect(getInputByPlaceholder("e.g. Claude Opus 4.8").disabled).toBe(true);
    expect(topPSwitch().disabled).toBe(true);

    // Save opens disabled and clicking the locked Top P toggle can't arm it.
    expect(getSaveBtn().disabled).toBe(true);
    fireEvent.click(topPSwitch());
    expect(getSaveBtn().disabled).toBe(true);
  });

  test("a disabled invariant profile keeps an enable-only toggle; saving PATCHes exactly {status:'active'} as a merge", async () => {
    const saveCalls: {
      name: string;
      entry: Record<string, unknown>;
      options?: { mode?: "merge" | "replace" };
    }[] = [];
    const onSave = (
      name: string,
      entry: unknown,
      options?: { mode?: "merge" | "replace" },
    ) => {
      saveCalls.push({
        name,
        entry: entry as Record<string, unknown>,
        options,
      });
      return Promise.resolve();
    };

    renderView({ ...invariantProfile, status: "disabled" }, onSave);

    // The re-enable affordance is present and Save starts disarmed.
    const activeSwitch = findSwitchByLabel("Active");
    expect(activeSwitch).not.toBeNull();
    expect(getSaveBtn().disabled).toBe(true);

    // Flip to active: Save arms, and the toggle disappears (the flip is
    // one-directional — an active invariant profile can't be disabled).
    fireEvent.click(activeSwitch!);
    expect(getSaveBtn().disabled).toBe(false);
    expect(findSwitchByLabel("Active")).toBeNull();

    fireEvent.click(getSaveBtn());

    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    // The body is exactly {status:"active"} — no label, no topP.
    expect(saveCalls[0].entry).toEqual({ status: "active" });
    expect(saveCalls[0].options?.mode).toBe("merge");
  });

  test("an invariant profile opened in edit mode keeps the lock (defense-in-depth)", () => {
    // The lock keys off the server-stamped wire flag alone, so even if a
    // parent opens an invariant profile in edit mode the lock must hold:
    // locked label and Top P, no delete/recreate save path.
    renderEdit(invariantProfile);

    expect(getInputByPlaceholder("e.g. Claude Opus 4.8").disabled).toBe(true);
    expect(topPSwitch().disabled).toBe(true);

    // The footer is the safe read-only footer: Save As New is offered and
    // Save stays disarmed (no status change to flip on an active profile).
    expect(getButton("Save As New")).not.toBeNull();
    expect(getSaveBtn().disabled).toBe(true);
  });

  test("an invariant profile in edit mode saves an enable flip as a {status:'active'} merge, never delete/recreate", async () => {
    const saveCalls: {
      name: string;
      entry: Record<string, unknown>;
      options?: { mode?: "merge" | "replace" };
    }[] = [];
    const onSave = (
      name: string,
      entry: unknown,
      options?: { mode?: "merge" | "replace" },
    ) => {
      saveCalls.push({
        name,
        entry: entry as Record<string, unknown>,
        options,
      });
      return Promise.resolve();
    };

    renderEdit({ ...invariantProfile, status: "disabled" }, onSave);

    const activeSwitch = findSwitchByLabel("Active");
    expect(activeSwitch).not.toBeNull();
    fireEvent.click(activeSwitch!);
    fireEvent.click(getSaveBtn());

    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    // The body is exactly {status:"active"} as a merge — the replace path
    // (delete/recreate) is never taken for invariant profiles.
    expect(saveCalls[0].entry).toEqual({ status: "active" });
    expect(saveCalls[0].options?.mode).toBe("merge");
  });

  test("a rejected re-enable surfaces the server's reason verbatim", async () => {
    // The daemon rejects activating a profile it can't dispatch through with a
    // 400 naming what's missing. Generic retry copy would send the user round
    // the same failing loop, so the server's message wins.
    const onSave = () =>
      Promise.reject(
        new ApiError(400, 'No API key for provider "gemini". Add one first.'),
      );

    renderView({ ...invariantProfile, status: "disabled" }, onSave);

    fireEvent.click(findSwitchByLabel("Active")!);
    fireEvent.click(getSaveBtn());

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        'No API key for provider "gemini". Add one first.',
      );
    });
    expect(document.body.textContent).not.toContain(
      "Failed to save profile. Please try again.",
    );
  });

  test("a non-400 failure keeps the generic retry copy", async () => {
    // A 500 carries internal detail — the modal must not leak it.
    const onSave = () => Promise.reject(new ApiError(500, "boom: db offline"));

    renderView({ ...invariantProfile, status: "disabled" }, onSave);

    fireEvent.click(findSwitchByLabel("Active")!);
    fireEvent.click(getSaveBtn());

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Failed to save profile. Please try again.",
      );
    });
    expect(document.body.textContent).not.toContain("boom: db offline");
  });

  test("Save As New from an invariant profile yields a fully editable create form", () => {
    renderView(invariantProfile);

    fireEvent.click(getButton("Save As New"));

    // The duplicate opens on a Name and key it can be saved under, so nothing
    // is wrong yet and the collapsed identity fields stay collapsed.
    expect(getButton("Advanced").getAttribute("aria-expanded")).toBe("false");
    expect(document.body.textContent).not.toContain("Name is required");
    fireEvent.click(getButton("Advanced"));

    // The duplicate drops the invariant lock: the Name is editable again.
    expect(getInputByPlaceholder("e.g. Claude Opus 4.8").disabled).toBe(false);
  });

  test("Save As New arms Save on a deduped name and the key it slugifies to", async () => {
    // The Key field is gone and the retained Name emits neither change nor
    // blur, so a duplicate that opened with an empty key would sit behind a
    // disabled Save with nothing on screen saying why. The source profile's
    // own key is taken, so the copy gains "(2)".
    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    const onSave = (name: string, entry: unknown) => {
      saveCalls.push({ name, entry: entry as Record<string, unknown> });
      return Promise.resolve();
    };

    renderView(invariantProfile, onSave);

    fireEvent.click(getButton("Save As New"));

    // Armed with no further input, and no blocking error to hide.
    expect(getSaveBtn().disabled).toBe(false);
    expect(document.querySelectorAll('[role="alert"]').length).toBe(0);

    fireEvent.click(getButton("Advanced"));
    expect(getInputByPlaceholder("e.g. Claude Opus 4.8").value).toBe(
      "Default A (2)",
    );

    fireEvent.click(getSaveBtn());

    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    // Saved under the slug of the deduped Name, not the source profile's key.
    expect(saveCalls[0].name).toBe("default-a-2");
    expect(saveCalls[0].entry.label).toBe("Default A (2)");
  });
});

// ---------------------------------------------------------------------------
// Why Save is disabled (LUM-3076)
// ---------------------------------------------------------------------------

describe("ProfileEditorModal: explains why Save is blocked", () => {
  /**
   * Field errors are announced, so assert on the alert rather than on page
   * text: "Select a provider" is also the picker's placeholder, and matching
   * that would pass with no error rendered at all.
   */
  function fieldErrors(): string[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>('[role="alert"]'),
    ).map((el) => el.textContent?.trim() ?? "");
  }

  test("a profile missing its provider says so on open", () => {
    // The Profiles row for an unusable profile links here saying "Click to
    // fix", so the reason has to be on screen before the user touches
    // anything. A disabled Save with no message is the bug.
    renderEdit({ name: "half-built", provider: "", model: "" });

    expect(fieldErrors()).toContain("Select a provider");
    expect(getSaveBtn().disabled).toBe(true);
  });

  test("a complete profile raises no field error", () => {
    renderEdit({
      name: "balanced",
      provider: "anthropic",
      model: "claude-opus-5",
    });

    expect(fieldErrors()).toEqual([]);
  });

  test("with no connections at all, the error is the way out", () => {
    // The blocking reason and the fix are the same fact here. Passing the
    // hint as helper text would hide it, since the field shows one message
    // and the error wins, leaving the user staring at "Select a provider"
    // above an empty list.
    renderEdit({ name: "half-built" }, undefined, []);

    expect(fieldErrors()).toContain(
      "No provider connections. Open Providers to add one.",
    );
    expect(fieldErrors()).not.toContain("Select a provider");
  });

  test("a locked profile is not told to fix a field it cannot edit", () => {
    // `invariant` forces read-only even in edit mode, so `effectiveMode` is
    // still "edit" and the error would otherwise render above a disabled
    // picker. Matches how `keyError` is already suppressed for these.
    renderEdit({ name: "my-managed", invariant: true });

    expect(fieldErrors()).toEqual([]);
  });

  test("an untouched create form does not scold the user for empty fields", () => {
    // Everything is empty because the user just opened it, not because they
    // did anything wrong.
    renderCreate([makeConnection("anthropic")]);

    expect(fieldErrors()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Entries wire shape (version-gated): daemons at the entry-binding gate store
// the binding IN the provider value and never receive provider_connection.
// ---------------------------------------------------------------------------

describe("entries wire shape", () => {
  const anthropicWork = {
    ...makeConnection("anthropic-work"),
    label: "Work key",
  } as unknown as ProviderConnection;
  const anthropicPersonal = makeConnection("anthropic-personal");

  async function gateOn() {
    const { useAssistantIdentityStore } =
      await import("@/stores/assistant-identity-store");
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-asst", "0.11.4", ASSISTANT_ID);
    return useAssistantIdentityStore;
  }

  function collectSaves() {
    const saveCalls: { name: string; entry: Record<string, unknown> }[] = [];
    const onSave = (name: string, entry: unknown) => {
      saveCalls.push({ name, entry: entry as Record<string, unknown> });
      return Promise.resolve();
    };
    return { saveCalls, onSave };
  }

  test("a multi-key kind expands into labeled entry rows plus a default row", () => {
    renderCreate([anthropicWork, anthropicPersonal]);
    fireEvent.click(providerTrigger());
    expect(optionRows().slice(0, 3)).toEqual([
      { label: "Anthropic", meta: "Default" },
      { label: "Work key", meta: "Anthropic" },
      { label: "anthropic-personal", meta: "Anthropic" },
    ]);
  });

  test("a single-key kind stays one bare row", () => {
    renderCreate([anthropicPersonal]);
    fireEvent.click(providerTrigger());
    expect(optionRows()[0]).toEqual({ label: "Anthropic", meta: "" });
  });

  test("a gated assistant writes the picked entry name as the provider", async () => {
    const store = await gateOn();
    try {
      const { saveCalls, onSave } = collectSaves();
      renderCreate([anthropicWork, anthropicPersonal], onSave);

      selectProvider("Work key");
      selectModel("Claude Opus 4.8");

      await waitFor(() => {
        expect(getSaveBtn().disabled).toBe(false);
      });
      fireEvent.click(getSaveBtn());

      await waitFor(() => {
        expect(saveCalls.length).toBe(1);
      });
      expect(saveCalls[0].entry.provider).toBe("anthropic-work");
      expect(saveCalls[0].entry.model).toBe("claude-opus-4-8");
      expect(saveCalls[0].entry.provider_connection).toBeUndefined();
    } finally {
      store.getState().clearIdentity();
    }
  });

  test("an ungated assistant writes the picked entry as the legacy binding", async () => {
    const { saveCalls, onSave } = collectSaves();
    renderCreate([anthropicWork, anthropicPersonal], onSave);

    selectProvider("Work key");
    selectModel("Claude Opus 4.8");

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());

    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.provider).toBe("anthropic");
    expect(saveCalls[0].entry.provider_connection).toBe("anthropic-work");
  });

  test("a gated single-key save writes the bare vendor and no binding", async () => {
    const store = await gateOn();
    try {
      const { saveCalls, onSave } = collectSaves();
      renderCreate([anthropicPersonal], onSave);

      selectProvider("Anthropic");
      selectModel("Claude Opus 4.8");

      await waitFor(() => {
        expect(getSaveBtn().disabled).toBe(false);
      });
      fireEvent.click(getSaveBtn());

      await waitFor(() => {
        expect(saveCalls.length).toBe(1);
      });
      // Bare vendor id = the kind's default entry; the auto-resolved
      // explicit binding is a legacy-shape concern.
      expect(saveCalls[0].entry.provider).toBe("anthropic");
      expect(saveCalls[0].entry.provider_connection).toBeUndefined();
    } finally {
      store.getState().clearIdentity();
    }
  });

  test("a gated endpoint save writes the endpoint name as the provider", async () => {
    const store = await gateOn();
    try {
      const lmStudio = {
        ...makeConnection("lm-studio", "openai-compatible"),
        models: [{ id: "model-1", displayName: "Model 1" }],
      } as unknown as ProviderConnection;
      const { saveCalls, onSave } = collectSaves();
      renderCreate([lmStudio], onSave);

      selectProvider("lm-studio");
      selectModel("Model 1");

      await waitFor(() => {
        expect(getSaveBtn().disabled).toBe(false);
      });
      fireEvent.click(getSaveBtn());

      await waitFor(() => {
        expect(saveCalls.length).toBe(1);
      });
      expect(saveCalls[0].entry.provider).toBe("lm-studio");
      expect(saveCalls[0].entry.provider_connection).toBeUndefined();
    } finally {
      store.getState().clearIdentity();
    }
  });

  test("a user row merely named vellum keeps the legacy shape under the gate", async () => {
    const store = await gateOn();
    try {
      const userVellum = {
        ...makeConnection("vellum"),
        provider: "anthropic",
      } as unknown as ProviderConnection;
      const { saveCalls, onSave } = collectSaves();
      renderCreate([userVellum], onSave);

      selectProvider("Anthropic");
      selectModel("Claude Opus 4.8");

      await waitFor(() => {
        expect(getSaveBtn().disabled).toBe(false);
      });
      fireEvent.click(getSaveBtn());

      await waitFor(() => {
        expect(saveCalls.length).toBe(1);
      });
      // "vellum" as a provider value would flip the profile to the managed
      // identity, so the binding stays in the legacy field.
      expect(saveCalls[0].entry.provider).toBe("anthropic");
      expect(saveCalls[0].entry.provider_connection).toBe("vellum");
    } finally {
      store.getState().clearIdentity();
    }
  });

  test("a vendor id is never read as an entry name, even when a row carries it", async () => {
    // A row can carry its vendor's own name; opening a plain unbound
    // profile must not pin it to that row.
    const selfNamed = makeConnection("anthropic");
    const { saveCalls, onSave } = collectSaves();
    renderEdit(
      {
        name: "plain",
        label: "Plain",
        provider: "anthropic",
        model: "claude-opus-4-8",
      },
      onSave,
      [selfNamed, anthropicPersonal],
    );

    fireEvent.click(getSaveBtn());
    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.provider).toBe("anthropic");
    // Two siblings, so no auto-resolve: the profile stays unbound instead
    // of quietly adopting the self-named row.
    expect(saveCalls[0].entry.provider_connection).toBeNull();
  });

  test("an explicit pin to a self-named row keeps the legacy shape under the gate", async () => {
    const store = await gateOn();
    try {
      // A row named exactly after its vendor cannot be written as an entry
      // name (the daemon reads the bare id as "the kind's default entry"),
      // so the explicit pin must stay in the legacy binding field.
      const selfNamed = makeConnection("anthropic");
      const { saveCalls, onSave } = collectSaves();
      renderEdit(
        {
          name: "pinned",
          label: "Pinned",
          provider: "anthropic",
          provider_connection: "anthropic",
          model: "claude-opus-4-8",
        },
        onSave,
        [selfNamed, anthropicPersonal],
      );

      fireEvent.click(getSaveBtn());
      await waitFor(() => {
        expect(saveCalls.length).toBe(1);
      });
      expect(saveCalls[0].entry.provider).toBe("anthropic");
      expect(saveCalls[0].entry.provider_connection).toBe("anthropic");
    } finally {
      store.getState().clearIdentity();
    }
  });

  test("a cross-kind identity binding shows the identity in the trigger", async () => {
    const chatgptRow = {
      ...makeConnection("chatgpt", "chatgpt"),
      auth: { type: "oauth_subscription", credential: "credential/chatgpt" },
    } as unknown as ProviderConnection;
    renderEdit(
      {
        name: "codex",
        label: "Codex",
        provider: "openai",
        provider_connection: "chatgpt",
        model: "gpt-5.6-sol",
      },
      undefined,
      [chatgptRow, makeConnection("openai-work", "openai")],
    );

    // The profile dispatches through the ChatGPT row, so the trigger names
    // that route rather than bare OpenAI.
    await waitFor(() => {
      expect(providerTrigger().textContent).toContain("ChatGPT");
    });
  });

  test("a stale binding among surviving siblings still labels the trigger", async () => {
    renderEdit(
      {
        name: "stale",
        label: "Stale",
        provider: "anthropic",
        provider_connection: "deleted-key",
        model: "claude-opus-4-8",
      },
      undefined,
      [anthropicWork, anthropicPersonal],
    );

    // The encoded value matches no option, so the trigger must fall back
    // to the bare kind rather than the placeholder.
    await waitFor(() => {
      expect(providerTrigger().textContent).toContain("Anthropic");
    });
  });

  test("a stored entry-name profile opens translated and round-trips", async () => {
    const store = await gateOn();
    try {
      const { saveCalls, onSave } = collectSaves();
      renderEdit(
        {
          name: "work",
          label: "Work",
          provider: "anthropic-work",
          model: "claude-opus-4-8",
        },
        onSave,
        [anthropicWork, anthropicPersonal],
      );

      // The trigger shows the entry row, not a raw entry name.
      await waitFor(() => {
        expect(providerTrigger().textContent).toContain("Work key");
      });

      fireEvent.click(getSaveBtn());
      await waitFor(() => {
        expect(saveCalls.length).toBe(1);
      });
      expect(saveCalls[0].entry.provider).toBe("anthropic-work");
      expect(saveCalls[0].entry.provider_connection).toBeNull();
    } finally {
      store.getState().clearIdentity();
    }
  });
});
