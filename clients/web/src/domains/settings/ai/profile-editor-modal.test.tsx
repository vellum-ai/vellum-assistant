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
 *    chosen.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import type { ProviderConnection } from "@/generated/daemon/types.gen";
import * as sdkGen from "@/generated/daemon/sdk.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let createdConnection: ProviderConnection;
let toastSuccessCalls: string[] = [];
const initialLifecycleState = useAssistantLifecycleStore.getState();

// Spy on the design-library toast so we can assert the shared ProfileEditorModal
// does NOT fire a profile-create success toast itself — that toast belongs to
// the surrounding surface (Settings via ManageProfilesModal, composer via its
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
  if (!btn) throw new Error("expected a modal-save-btn");
  return btn;
}

/** All Dropdown triggers (custom comboboxes) in document order. */
function dropdownTriggers(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[role="combobox"]'),
  );
}

/** Open the dropdown trigger and click the option whose label matches. */
function pickOption(trigger: HTMLButtonElement, optionLabel: string): void {
  fireEvent.click(trigger);
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === optionLabel);
  if (!option) {
    throw new Error(
      `expected option "${optionLabel}" — saw: ${Array.from(
        document.querySelectorAll('[role="option"]'),
      )
        .map((o) => `"${o.textContent?.trim()}"`)
        .join(", ")}`,
    );
  }
  fireEvent.click(option);
}

/** The create-mode Provider dropdown is labelled via `aria-labelledby`. */
function providerTrigger(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-labelledby="profile-editor-provider-label"]',
  );
  if (!trigger) throw new Error("expected the Provider dropdown trigger");
  return trigger;
}

/** Selects a provider in the create-mode Provider dropdown, then a model in
 *  the Model dropdown (the only other combobox once a provider is set). */
function selectProvider(label: string): void {
  pickOption(providerTrigger(), label);
}

function selectModel(label: string): void {
  // The Model dropdown is the combobox (other than Provider) whose open
  // listbox contains the target model label. Probing each candidate keeps the
  // helper robust to the optional Connection dropdown appearing alongside it.
  const provTrigger = providerTrigger();
  for (const trigger of dropdownTriggers()) {
    if (trigger === provTrigger) continue;
    fireEvent.click(trigger);
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((o) => o.textContent?.trim() === label);
    if (option) {
      fireEvent.click(option);
      return;
    }
    // Close this listbox before probing the next trigger.
    fireEvent.click(trigger);
  }
  throw new Error(`expected a Model dropdown offering "${label}"`);
}

function renderCreate(
  connections: ProviderConnection[],
  onSave: (name: string, entry: unknown) => Promise<void> = () =>
    Promise.resolve(),
) {
  return render(
    <Wrapper>
      <ProfileEditorModal
        isOpen
        mode="create"
        existingNames={[]}
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
) {
  return render(
    <Wrapper>
      <ProfileEditorModal
        isOpen
        mode="edit"
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
  if (!sw) throw new Error("expected a Top P switch");
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
  if (!slider) throw new Error("expected a Top P slider (aria-valuemax=1)");
  return slider;
}

/** Drive a provider-first create up to a Save-enabled state. */
function fillCreateForm(): void {
  selectProvider("Anthropic");
  selectModel("Claude Opus 4.8");
  fireEvent.click(getButton("Advanced"));
  fireEvent.change(getInputByPlaceholder("e.g. fast-cheap"), {
    target: { value: "my-profile" },
  });
}

beforeEach(() => {
  createdConnection = makeConnection("anthropic-personal");
  toastSuccessCalls = [];
  useAssistantLifecycleStore.setState(initialLifecycleState, true);
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProfileEditorModal create mode — provider-first", () => {
  test("keeps Name and Key inside Advanced in create mode", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    selectProvider("Anthropic");
    selectModel("Claude Opus 4.8");

    expect(
      document.querySelector('input[placeholder="e.g. Fast & Cheap"]'),
    ).toBeNull();
    expect(
      document.querySelector('input[placeholder="e.g. fast-cheap"]'),
    ).toBeNull();

    fireEvent.click(getButton("Advanced"));

    expect(getInputByPlaceholder("e.g. Fast & Cheap")).toBeDefined();
    expect(getInputByPlaceholder("e.g. fast-cheap")).toBeDefined();
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

  test("selecting a model pre-fills Name and Key", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    selectProvider("Anthropic");
    selectModel("Claude Opus 4.8");
    fireEvent.click(getButton("Advanced"));

    expect(getInputByPlaceholder("e.g. Fast & Cheap").value).toBe(
      "Claude Opus 4.8",
    );
    expect(getInputByPlaceholder("e.g. fast-cheap").value).toBe(
      "claude-opus-4-8",
    );
  });

  test("editing Name stops model-driven pre-fill from overwriting", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    selectProvider("Anthropic");
    selectModel("Claude Opus 4.8");
    fireEvent.click(getButton("Advanced"));

    // User overrides the Name.
    fireEvent.change(getInputByPlaceholder("e.g. Fast & Cheap"), {
      target: { value: "My Custom Profile" },
    });

    // Selecting a different model must NOT clobber the manual Name/Key.
    selectModel("Claude Opus 4.7");

    expect(getInputByPlaceholder("e.g. Fast & Cheap").value).toBe(
      "My Custom Profile",
    );
    expect(getInputByPlaceholder("e.g. fast-cheap").value).toBe(
      "my-custom-profile",
    );
  });

  test("first-run empty state shows only the create-new-provider option", () => {
    renderCreate([]);
    fireEvent.click(providerTrigger());
    const optionLabels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((o) => o.textContent?.trim());
    expect(optionLabels).toEqual(["+ Create new provider"]);
  });

  test("the Vellum-managed connection surfaces every managed-routable provider", () => {
    // A platform-hosted user's only connection is the single provider-agnostic
    // `vellum` connection. It must expand into the managed-routable providers
    // so the picker isn't limited to "+ Create new provider".
    renderCreate([makeConnection("vellum-managed", "vellum")]);
    fireEvent.click(providerTrigger());
    const optionLabels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((o) => o.textContent?.trim());
    // A single Vellum entry — never the managed upstreams it routes to.
    expect(optionLabels).toEqual(["Vellum", "+ Create new provider"]);
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
      expect(providerTrigger().textContent?.trim()).toBe("Vellum");
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

    await waitFor(() => {
      expect(providerTrigger().textContent?.trim()).toBe("OpenAI-compatible");
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

  test("a BYOK connection surfaces its own provider", () => {
    // A self-hosted user who entered an Anthropic API key gets an `anthropic`
    // connection, which must surface Anthropic as a selectable provider.
    renderCreate([makeConnection("anthropic-personal", "anthropic")]);
    fireEvent.click(providerTrigger());
    const optionLabels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((o) => o.textContent?.trim());
    expect(optionLabels).toEqual(["Anthropic", "+ Create new provider"]);
  });

  test("a provider unknown to the catalog shows an explicit empty-model state", () => {
    // "acme-llm" isn't in the static web catalog — `getModelsForProvider`
    // returns [] for unknown ids — reproducing the drift scenario where a
    // connection exists for a provider this app version doesn't know about.
    renderCreate([makeConnection("acme-llm-personal", "acme-llm")]);

    selectProvider("acme-llm");

    // The Model dropdown trigger explains the empty list instead of showing
    // a bare "Select a model" placeholder over zero options...
    const triggerLabels = dropdownTriggers().map((t) => t.textContent?.trim());
    expect(triggerLabels).toContain("No models available");
    expect(triggerLabels).not.toContain("Select a model");

    // ...and the hint below spells out why and what to do about it.
    expect(document.body.textContent).toContain(
      "No models are available for this provider in this app version. " +
        "Update the app, or use an OpenAI-compatible connection to enter a custom model.",
    );
  });

  test("Ollama connections offer the bundled local models", () => {
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "self_hosted" },
    });
    renderCreate([makeConnection("ollama", "ollama")]);

    selectProvider("Ollama");

    const triggerLabels = dropdownTriggers().map((t) => t.textContent?.trim());
    expect(triggerLabels).toContain("Select a model");
    expect(triggerLabels).not.toContain("No models available");

    selectModel("Llama 3.2");
    fireEvent.click(getButton("Advanced"));
    expect(getInputByPlaceholder("e.g. Fast & Cheap").value).toBe("Llama 3.2");
    expect(getInputByPlaceholder("e.g. fast-cheap").value).toBe("llama-3-2");

    selectModel("Mistral");
    expect(getInputByPlaceholder("e.g. Fast & Cheap").value).toBe("Mistral");
    expect(getInputByPlaceholder("e.g. fast-cheap").value).toBe("mistral");
  });

  test("platform-hosted assistants do not offer Ollama as a new profile provider", () => {
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "active", isLocal: false },
    });
    renderCreate([makeConnection("ollama", "ollama")]);

    fireEvent.click(providerTrigger());

    const optionLabels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((o) => o.textContent?.trim());
    expect(optionLabels).toEqual(["+ Create new provider"]);
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

    // Pick a model + key, then save immediately (no connections refetch).
    selectModel("Claude Opus 4.8");
    fireEvent.click(getButton("Advanced"));
    fireEvent.change(getInputByPlaceholder("e.g. fast-cheap"), {
      target: { value: "my-profile" },
    });

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

    // The Model trigger surfaces the bound id (no catalog/connection name
    // available, so it falls back to the raw id) rather than the empty
    // placeholder...
    const triggerLabels = dropdownTriggers().map((t) => t.textContent?.trim());
    expect(triggerLabels).toContain("openrouter/fusion");
    expect(triggerLabels).not.toContain("Select a model");

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

    // Open each combobox; the Model dropdown must list the bound id so it can
    // be re-selected manually (the second reported surface of JARVIS-1180).
    const optionLabels = dropdownTriggers().flatMap((trigger) => {
      fireEvent.click(trigger);
      const labels = Array.from(
        document.querySelectorAll<HTMLElement>('[role="option"]'),
      ).map((o) => o.textContent?.trim());
      fireEvent.click(trigger);
      return labels;
    });
    expect(optionLabels).toContain("openrouter/fusion");
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

    // The incompatible model is auto-cleared: the Model trigger falls back to the
    // placeholder and never surfaces "GPT-5.5 Pro".
    await waitFor(() => {
      const labels = dropdownTriggers().map((t) => t.textContent?.trim());
      expect(labels).toContain("Select a model");
    });
    expect(dropdownTriggers().map((t) => t.textContent?.trim())).not.toContain(
      "GPT-5.5 Pro",
    );

    // The dropdown offers the Codex-compatible models but not the filtered one.
    const optionLabels = dropdownTriggers().flatMap((trigger) => {
      fireEvent.click(trigger);
      const labels = Array.from(
        document.querySelectorAll<HTMLElement>('[role="option"]'),
      ).map((o) => o.textContent?.trim());
      fireEvent.click(trigger);
      return labels;
    });
    expect(optionLabels).toContain("GPT-5.5");
    expect(optionLabels).not.toContain("GPT-5.5 Pro");
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
    expect(getInputByPlaceholder("e.g. Fast & Cheap").disabled).toBe(true);
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

    expect(getInputByPlaceholder("e.g. Fast & Cheap").disabled).toBe(true);
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

  test("Save As New from an invariant profile yields a fully editable create form", () => {
    renderView(invariantProfile);

    fireEvent.click(getButton("Save As New"));

    // Clearing the generated key does not surface a validation error before
    // the user interacts with the collapsed identity fields.
    expect(getButton("Advanced").getAttribute("aria-expanded")).toBe("false");
    expect(document.body.textContent).not.toContain("Key is required");
    fireEvent.click(getButton("Advanced"));

    // The duplicate drops the invariant lock: name and key are editable and
    // the Active toggle is back.
    expect(getInputByPlaceholder("e.g. Fast & Cheap").disabled).toBe(false);
    expect(getInputByPlaceholder("e.g. fast-cheap").disabled).toBe(false);
    expect(findSwitchByLabel("Active")).not.toBeNull();
  });
});
