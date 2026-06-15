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
 *  - field order is provider-first (Provider before Name/Key/Description),
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

import type { ProviderConnection } from "@/generated/daemon/types.gen";
import * as sdkGen from "@/generated/daemon/sdk.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let createdConnection: ProviderConnection;
let toastSuccessCalls: string[] = [];

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
  credentialPresenceQueryKey: (assistantId: string, kind: string, name: string) =>
    ["credentialPresence", assistantId, kind, name] as const,
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

const { ProfileEditorModal } = await import(
  "@/domains/settings/ai/profile-editor-modal"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSISTANT_ID = "asst-1";

function makeConnection(name: string, provider = "anthropic"): ProviderConnection {
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
    defaultOptions: { queries: { retry: false } },
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

/** Drive a provider-first create up to a Save-enabled state. */
function fillCreateForm(): void {
  selectProvider("Anthropic");
  selectModel("Claude Opus 4.8");
  fireEvent.change(getInputByPlaceholder("e.g. fast-cheap"), {
    target: { value: "my-profile" },
  });
}

beforeEach(() => {
  createdConnection = makeConnection("anthropic-personal");
  toastSuccessCalls = [];
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProfileEditorModal create mode — provider-first", () => {
  test("renders Provider before Name/Key in create mode", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    const text = document.body.textContent ?? "";
    const providerIdx = text.indexOf("Provider");
    const nameIdx = text.indexOf("Name");
    const keyIdx = text.indexOf("Key");
    expect(providerIdx).toBeGreaterThanOrEqual(0);
    expect(nameIdx).toBeGreaterThan(providerIdx);
    expect(keyIdx).toBeGreaterThan(providerIdx);
  });

  test("Advanced is hidden until a model is chosen, then collapsed by default", () => {
    renderCreate([makeConnection("anthropic-personal")]);

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

  test("+ Create new provider mounts ProviderCreateForm; successful create selects it and Save enables after a model", async () => {
    renderCreate([]);

    selectProvider("+ Create new provider");

    // Inline ProviderCreateForm is mounted (its Key field placeholder).
    const inlineKey = getInputByPlaceholder("e.g. anthropic-personal");
    expect(inlineKey).toBeDefined();

    // Fill the inline form and create (anthropic defaults to platform auth,
    // so no API key entry is required).
    fireEvent.change(inlineKey, { target: { value: "anthropic-personal" } });
    fireEvent.click(getButton("Create"));

    // After create, the sub-form collapses and the provider is selected.
    await waitFor(() => {
      expect(
        document.body.textContent,
      ).toContain(
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
    fireEvent.change(getInputByPlaceholder("e.g. anthropic-personal"), {
      target: { value: "anthropic-personal" },
    });
    fireEvent.click(getButton("Create"));

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "New provider connection will show up in the Providers section.",
      );
    });

    // Pick a model + key, then save immediately (no connections refetch).
    selectModel("Claude Opus 4.8");
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
});
