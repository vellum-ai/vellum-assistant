/**
 * The create flow under `model-first-profile-create`: the model is chosen
 * first, and the provider question is asked only as far as it needs to be.
 *
 * The generated daemon SDK and the credential hooks are mocked the way
 * `profile-editor-modal.test.tsx` mocks them, so the inline
 * `ProviderCreateForm` can run its create sequence without network calls. The
 * ChatGPT connect section is stubbed to a button: its own sign-in flows have
 * their own tests, and what matters here is that this flow mounts that
 * section and routes its connection into the editor.
 *
 * Coverage:
 *  - flag off leaves the provider-first flow exactly as it was,
 *  - one model row per model, annotated with who serves it,
 *  - a single connected route is stated rather than offered,
 *  - several routes become cards, connected ones first and pre-selected,
 *  - an unconnected route blocks Save and expands its own connect form,
 *  - ChatGPT is a candidate for Codex-eligible models only, and saves the
 *    same payload the provider-first flow saves,
 *  - the custom model id escape hatch.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { ProviderConnection } from "@/generated/daemon/types.gen";
import * as sdkGen from "@/generated/daemon/sdk.gen";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let createdConnection: ProviderConnection;

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {}, warning: () => {} },
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
  useProviderCredentialsList: () => ({ credentials: [], isLoading: false }),
}));

mock.module("@/domains/settings/ai/chatgpt-oauth-section", () => ({
  ChatgptOAuthSection: ({
    onConnected,
  }: {
    onConnected: (connection: ProviderConnection) => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "chatgpt-connect-stub",
        onClick: () => onConnected(createdConnection),
      },
      "Sign in with ChatGPT",
    ),
}));

const { ProfileEditorModal } = await import(
  "@/domains/settings/ai/profile-editor-modal"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSISTANT_ID = "asst-1";

function makeConnection(
  name: string,
  provider = "anthropic",
  overrides: Record<string, unknown> = {},
): ProviderConnection {
  return {
    name,
    label: null,
    provider,
    auth: { type: "api_key", credential: `credential/${provider}/api_key` },
    models: null,
    ...overrides,
  } as unknown as ProviderConnection;
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

type SaveCall = { name: string; entry: Record<string, unknown> };

function renderCreate(
  connections: ProviderConnection[],
  saveCalls: SaveCall[] = [],
) {
  render(
    <Wrapper>
      <ProfileEditorModal
        isOpen
        mode="create"
        existingNames={[]}
        connections={connections}
        assistantId={ASSISTANT_ID}
        onSave={(name, entry) => {
          saveCalls.push({ name, entry: entry as Record<string, unknown> });
          return Promise.resolve();
        }}
        onCancel={() => {}}
      />
    </Wrapper>,
  );
  return saveCalls;
}

function modelField(): HTMLInputElement {
  const field = document.querySelector<HTMLInputElement>(
    'input[role="combobox"][aria-label="Model"]',
  );
  if (!field) {
    throw new Error("expected the Model field");
  }
  return field;
}

/** An option row's label, excluding any right-aligned suffix meta. */
function optionLabel(option: Element): string {
  return (
    option.querySelector(".truncate")?.textContent ??
    option.textContent ??
    ""
  ).trim();
}

function openModelList(): void {
  fireEvent.focus(modelField());
}

function modelRows(): { label: string; meta: string }[] {
  openModelList();
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map((option) => {
    const label = optionLabel(option);
    const full = (option.textContent ?? "").trim();
    return { label, meta: full.slice(label.length).trim() };
  });
}

function selectModel(label: string): void {
  openModelList();
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => optionLabel(o) === label);
  if (!option) {
    throw new Error(
      `expected a Model list offering "${label}" - saw ${
        document.querySelectorAll('[role="option"]').length
      } rows`,
    );
  }
  fireEvent.click(option);
}

function candidateCards(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="provider-candidate"]'),
  );
}

function candidateValues(): string[] {
  return candidateCards().map((card) => card.dataset.candidate ?? "");
}

function candidateCard(value: string): HTMLElement {
  const card = candidateCards().find((c) => c.dataset.candidate === value);
  if (!card) {
    throw new Error(
      `expected a "${value}" candidate - saw ${candidateValues().join(", ")}`,
    );
  }
  return card;
}

function selectedCandidateValue(): string | null {
  const checked = candidateCards().find(
    (card) =>
      card.querySelector('[role="radio"]')?.getAttribute("aria-checked") ===
      "true",
  );
  return checked?.dataset.candidate ?? null;
}

function pickCandidate(value: string): void {
  const radio = candidateCard(value).querySelector<HTMLElement>(
    '[role="radio"]',
  );
  if (!radio) {
    throw new Error(`expected a radio in the "${value}" candidate`);
  }
  fireEvent.click(radio);
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

function getButton(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === label);
  if (!match) {
    throw new Error(`expected a "${label}" button`);
  }
  return match;
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

function setModelFirstFlag(value: boolean): void {
  useClientFeatureFlagStore.setState({ modelFirstProfileCreate: value });
}

beforeEach(() => {
  createdConnection = makeConnection("openai-personal", "openai");
  setModelFirstFlag(true);
  // Save awaits the entry-binding version gate, so a hydrated identity keeps
  // it from waiting out its timeout. The floor is pinned below the gate, which
  // is the legacy payload the provider-first flow writes on the same daemon.
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", "0.10.11", ASSISTANT_ID);
});

afterEach(() => {
  cleanup();
  setModelFirstFlag(false);
  useAssistantIdentityStore.getState().clearIdentity();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("the flag", () => {
  test("off leaves the provider-first flow in place", () => {
    setModelFirstFlag(false);
    renderCreate([makeConnection("anthropic-personal")]);

    expect(
      document.querySelector(
        'button[role="combobox"][aria-labelledby="profile-editor-provider-label"]',
      ),
    ).not.toBeNull();
    expect(candidateCards()).toHaveLength(0);
    // The provider-first Model field stays disabled until a provider is
    // chosen, which is the shape of the old flow.
    expect(modelField().getAttribute("aria-disabled")).not.toBe("true");
  });

  test("on replaces the provider dropdown with the model list", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    expect(
      document.querySelector(
        'button[role="combobox"][aria-labelledby="profile-editor-provider-label"]',
      ),
    ).toBeNull();
    expect(modelField()).not.toBeNull();
  });
});

describe("the model list", () => {
  test("offers each model once, annotated with who serves it", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    const rows = modelRows();
    const opus = rows.filter((row) => row.label === "Claude Opus 4.8");
    expect(opus).toHaveLength(1);
    expect(opus[0].meta).toBe("3 providers");

    const gemini = rows.find((row) => row.label === "Gemini 3.6 Flash");
    expect(gemini?.meta).toBe("Google Gemini");
  });

  test("keeps the custom model id escape hatch at the bottom", () => {
    renderCreate([makeConnection("anthropic-personal")]);
    expect(modelRows().map((row) => row.label)).toContain(
      "Enter a custom model ID…",
    );
  });
});

describe("the provider step", () => {
  test("states a single connected route rather than offering it", async () => {
    const saveCalls = renderCreate([makeConnection("gemini-key", "gemini")]);

    selectModel("Gemini 3.6 Flash");

    expect(candidateValues()).toEqual(["gemini"]);
    expect(candidateCard("gemini").textContent).toContain("Connected");
    expect(document.body.textContent).toContain(
      "Only Google Gemini serves this model.",
    );
    expect(document.querySelectorAll('[role="radio"]')).toHaveLength(0);

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());
    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.provider).toBe("gemini");
    expect(saveCalls[0].entry.model).toBe("gemini-3.6-flash");
  });

  test("puts connected routes first and pre-selects one", () => {
    renderCreate([
      makeConnection("openrouter-key", "openrouter"),
      makeConnection("anthropic-personal"),
    ]);

    selectModel("Claude Opus 4.8");

    expect(candidateValues()).toEqual([
      "anthropic",
      "openrouter",
      "vercel-ai-gateway",
    ]);
    expect(selectedCandidateValue()).toBe("anthropic");
    expect(candidateCard("anthropic").textContent).toContain("Connected");
    expect(candidateCard("vercel-ai-gateway").textContent).toContain(
      "Add API key",
    );
  });

  test("switching routes rewrites the model id for the new one", async () => {
    const saveCalls = renderCreate([
      makeConnection("anthropic-personal"),
      makeConnection("openrouter-key", "openrouter"),
    ]);

    selectModel("Claude Opus 4.8");
    pickCandidate("openrouter");

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());
    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.provider).toBe("openrouter");
    expect(saveCalls[0].entry.model).toBe("anthropic/claude-opus-4.8");
  });

  test("names the key a route with siblings would use", () => {
    renderCreate([
      makeConnection("anthropic-work"),
      makeConnection("anthropic-personal", "anthropic", { label: "Personal" }),
    ]);

    selectModel("Claude Opus 4.8");

    expect(candidateValues().slice(0, 3)).toEqual([
      "anthropic",
      "anthropic::anthropic-work",
      "anthropic::anthropic-personal",
    ]);
    expect(candidateCard("anthropic::anthropic-personal").textContent).toContain(
      "Personal",
    );
  });
});

describe("a route with no connection yet", () => {
  test("blocks Save and expands its own connect form", async () => {
    renderCreate([makeConnection("anthropic-personal")]);

    selectModel("Claude Opus 4.8");
    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });

    pickCandidate("openrouter");

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(true);
    });
    // The inline create form seeds a Display Name for the chosen provider and
    // hides its own provider selector, which the outer card already names.
    expect(getButton("Add")).not.toBeNull();
    expect(
      document.querySelector('button[role="combobox"][aria-label="Provider"]'),
    ).toBeNull();
  });

  test("connecting it binds the profile and re-applies the model", async () => {
    createdConnection = makeConnection("openrouter-key", "openrouter");
    const saveCalls = renderCreate([makeConnection("anthropic-personal")]);

    selectModel("Claude Opus 4.8");
    pickCandidate("openrouter");

    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "sk-test-key" },
    });
    fireEvent.click(getButton("Add"));

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());
    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.provider).toBe("openrouter");
    expect(saveCalls[0].entry.model).toBe("anthropic/claude-opus-4.8");
    expect(saveCalls[0].entry.provider_connection).toBe("openrouter-key");
    // The Name still comes from the model's display name, not its raw id.
    expect(saveCalls[0].name).toBe("claude-opus-4-8");
  });
});

describe("the ChatGPT subscription", () => {
  test("is a candidate for a Codex-eligible model and nothing else", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    selectModel("GPT-5.6 Luna");
    expect(candidateValues()).toContain("chatgpt");
    expect(candidateCard("chatgpt").textContent).toContain("Sign in");

    selectModel("GPT-5.4 Nano");
    expect(candidateValues()).not.toContain("chatgpt");
  });

  test("expands the shared connect section rather than a create form", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    selectModel("GPT-5.6 Luna");
    pickCandidate("chatgpt");

    expect(
      document.querySelector('[data-testid="chatgpt-connect-stub"]'),
    ).not.toBeNull();
  });

  test("leads once signed in and saves the identity payload", async () => {
    const saveCalls = renderCreate([
      makeConnection("chatgpt", "chatgpt", {
        auth: {
          type: "oauth_subscription",
          credential: "credential/chatgpt/oauth",
        },
      }),
    ]);

    selectModel("GPT-5.6 Luna");
    expect(selectedCandidateValue()).toBe("chatgpt");

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());
    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.provider).toBe("chatgpt");
    expect(saveCalls[0].entry.model).toBe("gpt-5.6-luna");
    expect(saveCalls[0].entry.provider_connection).toBeUndefined();
  });
});

describe("the custom model id path", () => {
  test("saves the typed id through the chosen route", async () => {
    const saveCalls = renderCreate([makeConnection("openrouter-key", "openrouter")]);

    selectModel("Enter a custom model ID…");
    fireEvent.change(getInputByPlaceholder("provider/model-id"), {
      target: { value: "someone/new-model" },
    });
    pickCandidate("openrouter");

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());
    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.provider).toBe("openrouter");
    expect(saveCalls[0].entry.model).toBe("someone/new-model");
  });

  test("never offers the subscription, which only accepts Codex ids", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    selectModel("Enter a custom model ID…");
    expect(candidateValues()).not.toContain("chatgpt");
  });

  test("returns to the list without keeping the typed id", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    selectModel("Enter a custom model ID…");
    fireEvent.change(getInputByPlaceholder("provider/model-id"), {
      target: { value: "someone/new-model" },
    });
    fireEvent.click(getButton("Choose from list"));

    expect(modelField()).not.toBeNull();
    expect(getSaveBtn().disabled).toBe(true);
  });
});
