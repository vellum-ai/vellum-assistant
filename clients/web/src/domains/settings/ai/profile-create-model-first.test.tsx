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
 *  - one model row per model, and only the model's name on it,
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

import {
  SEARCHABLE_SELECT_MENU_MIN_REACH,
  SEARCHABLE_SELECT_MENU_REACH,
} from "@vellumai/design-library/components/searchable-select";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
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

const initialLifecycleState = useAssistantLifecycleStore.getState();

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

/** The field stack, which is where the dialog's reserve for the list sits. */
function fieldStack(): HTMLElement {
  const stack = document.querySelector<HTMLElement>(
    '[data-testid="model-first-fields"]',
  );
  if (!stack) {
    throw new Error("expected the model-first field stack");
  }
  return stack;
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

/** Row labels of the already-open list, in order. */
function modelOptionLabels(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map(optionLabel);
}

/** A section's own name, which its heading carries beside its disclosure. */
function headingName(group: Element): string {
  return (
    group.querySelector('[data-slot="combobox-group-name"]')?.textContent ?? ""
  ).trim();
}

/** Section headings on the open list, in order. */
function groupHeadings(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="combobox-group"]'),
  ).map(headingName);
}

/** Row labels inside one section, which is where a label is unambiguous. */
function sectionRowLabels(heading: string): string[] {
  const section = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="combobox-group"]'),
  ).find((group) => headingName(group) === heading);
  if (!section) {
    throw new Error(
      `expected a "${heading}" section - saw ${groupHeadings().join(", ")}`,
    );
  }
  return Array.from(
    section.querySelectorAll<HTMLElement>('[role="option"]'),
  ).map(optionLabel);
}

/** One section's disclosure, which its heading carries. */
function sectionAction(heading: string): HTMLElement {
  const section = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="combobox-group"]'),
  ).find((group) => headingName(group) === heading);
  const action = section
    ?.querySelector('[data-slot="combobox-group-label"]')
    ?.querySelector<HTMLElement>('[role="option"]');
  if (!action) {
    throw new Error(`expected a disclosure on the "${heading}" heading`);
  }
  return action;
}

/** Type into the model field, which is the list's own search box. */
function searchModels(query: string): void {
  openModelList();
  fireEvent.change(modelField(), { target: { value: query } });
}

function clickModelOption(label: string): void {
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

/**
 * Picks a model by name through the query that finds it, which is the one
 * path that reaches every model: a section offers three and folds the rest.
 */
function selectModel(label: string): void {
  searchModels(label);
  clickModelOption(label);
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

/**
 * The card's own row, which is the label the whole card's dead space belongs
 * to. Clicking it is what a click beside the name or the tag amounts to.
 */
function candidateRow(value: string): HTMLLabelElement {
  const row = candidateCard(value).firstElementChild;
  if (!(row instanceof HTMLLabelElement)) {
    throw new Error(`expected the "${value}" card's row to be a label`);
  }
  return row;
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

function hasInputWithPlaceholder(placeholder: string): boolean {
  return Array.from(document.querySelectorAll<HTMLInputElement>("input")).some(
    (el) => el.placeholder === placeholder,
  );
}

/**
 * The inline connect form's own dismiss action. It is named apart from the
 * dialog's Cancel, which sits right below it and abandons the whole profile.
 */
function inlineCancelButton(): HTMLButtonElement {
  return getButton("Cancel setup");
}

/**
 * Expand the connect form's own Advanced disclosure. Idempotent, so a form
 * that survived a route change (the bug this guards) is not toggled shut and
 * the assertion lands on its stale seed rather than on a missing field.
 */
function openCreateFormAdvanced(): void {
  const toggle = getButton("Advanced");
  if (toggle.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(toggle);
  }
}

function setupActionButton(): HTMLButtonElement {
  const match = document.querySelector<HTMLButtonElement>(
    '[data-testid="candidate-setup-btn"]',
  );
  if (!match) {
    throw new Error("expected a setup action on the provider card");
  }
  return match;
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
  useAssistantLifecycleStore.setState(initialLifecycleState);
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
  test("offers each model once, and says nothing else on the row", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    const rows = modelRows();
    const opus = rows.filter((row) => row.label === "Claude Opus 5");
    expect(opus).toHaveLength(1);
    expect(opus[0].meta).toBe("");

    const gemini = rows.find((row) => row.label === "Gemini 3.8 Flash");
    expect(gemini?.meta).toBe("");
  });

  test("keeps the custom model id escape hatch at the bottom", () => {
    renderCreate([makeConnection("anthropic-personal")]);
    expect(modelRows().map((row) => row.label)).toContain(
      "Enter a custom model ID…",
    );
  });

  test("files models under whoever made them, reachable sections first", () => {
    renderCreate([makeConnection("gemini-key", "gemini")]);
    openModelList();

    const headings = groupHeadings();
    expect(headings.slice(0, 2)).toEqual(["Google Gemini", "Anthropic"]);
    // Grok is xAI's work, whichever gateway happens to serve it, and no
    // gateway names a section of its own.
    expect(headings).toContain("xAI");
    expect(sectionRowLabels("xAI")).toContain("Grok 4.6");
    expect(headings).not.toContain("OpenRouter");
    expect(headings).not.toContain("Fireworks");
    expect(headings).not.toContain("Together AI");
  });

  test("draws one section for a vendor several providers serve", () => {
    renderCreate([makeConnection("anthropic-personal")]);
    openModelList();

    expect(
      groupHeadings().filter((heading) => heading === "MiniMax"),
    ).toHaveLength(1);
    // Fireworks lists the newest MiniMax and OpenRouter the older ones.
    expect(sectionRowLabels("MiniMax")).toContain("MiniMax M3");
  });

  test("offers three models per section and folds the rest behind See more", () => {
    renderCreate([makeConnection("anthropic-personal")]);
    openModelList();

    // The disclosure sits on the heading, ahead of the three rows the section
    // offers, whatever it holds behind it.
    expect(sectionRowLabels("Anthropic")).toEqual([
      "See more",
      "Claude Fable 5.1",
      "Claude Opus 5",
      "Claude Sonnet 5",
    ]);
    expect(sectionAction("Anthropic").getAttribute("aria-expanded")).toBe(
      "false",
    );

    clickModelOption("See more");

    // The list stays open on the row that was just acted on, and the rest of
    // the section follows the three it already offered.
    expect(sectionRowLabels("Anthropic")).toContain("Claude Haiku 4.5");
    expect(sectionRowLabels("Anthropic")).toContain("Claude Opus 4.8");
    // Unfolding is not an answer: no model is chosen by it.
    expect(getSaveBtn().disabled).toBe(true);

    // The same control folds the section back up.
    expect(sectionAction("Anthropic").getAttribute("aria-expanded")).toBe(
      "true",
    );
    clickModelOption("See less");
    expect(sectionRowLabels("Anthropic")).toEqual([
      "See more",
      "Claude Fable 5.1",
      "Claude Opus 5",
      "Claude Sonnet 5",
    ]);
  });

  test("a query reaches a folded model and drops the unfold row", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    searchModels("Opus 4.8");

    expect(modelOptionLabels()).toContain("Claude Opus 4.8");
    expect(modelOptionLabels()).not.toContain("See more");
    // The headings survive a query, so a match is still placed.
    expect(groupHeadings()).toEqual(["Anthropic"]);
  });

  test("a folded model picked from a query is the model chosen", async () => {
    const saveCalls = renderCreate([makeConnection("anthropic-personal")]);

    searchModels("Opus 4.8");
    clickModelOption("Claude Opus 4.8");

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());
    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.model).toBe("claude-opus-4-8");
  });
});

describe("the room the dialog keeps for the open list", () => {
  test("is reserved while the Model field is the whole of it", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    // The list is portaled, so the dialog holds it only because the stack
    // under the field says how far it reaches.
    expect(
      Number.parseInt(fieldStack().style.minHeight, 10),
    ).toBeGreaterThanOrEqual(SEARCHABLE_SELECT_MENU_REACH);
  });

  test("opens with the field that fills it focused, against a late focus restore", async () => {
    // The surface that opens the dialog takes the focus back: a menu closing
    // over it restores focus to its own trigger on a timer queued before the
    // dialog mounts, so the restore lands after the dialog's opening focus.
    // The elsewhere it lands is inside the dialog, which is where the
    // dialog's own focus trap would send it anyway.
    const elsewhere = document.createElement("button");
    const focusTheRestoreTook: Element[] = [];
    const restore = setTimeout(() => {
      const held = document.activeElement;
      if (held) {
        focusTheRestoreTook.push(held);
      }
      fieldStack().closest("div[role='dialog']")?.append(elsewhere);
      elsewhere.focus();
    }, 0);

    renderCreate([makeConnection("anthropic-personal")]);

    // The restore does take the field the dialog itself focused, which is the
    // race the claim below has to win.
    await waitFor(() => {
      expect(focusTheRestoreTook).toHaveLength(1);
    });
    expect(focusTheRestoreTook[0]).toBe(modelField());

    // The list opens on the field's own focus, so a focused field is what
    // puts the list in the room above rather than leaving it blank.
    await waitFor(() => {
      expect(document.activeElement).toBe(modelField());
    });
    expect(modelField().getAttribute("aria-expanded")).toBe("true");

    clearTimeout(restore);
    elsewhere.remove();
  });

  test("still stands once a model answers the question", () => {
    renderCreate([makeConnection("gemini-key", "gemini")]);

    selectModel("Gemini 3.6 Flash");

    // The field outlives the question, so the list can be reopened over
    // whatever the answer put under it. A sole connected route is the
    // shortest of those, and giving the room back here is what let a
    // reopened list cover the dialog's own footer.
    expect(candidateCards().length).toBe(1);
    expect(
      Number.parseInt(fieldStack().style.minHeight, 10),
    ).toBeGreaterThanOrEqual(SEARCHABLE_SELECT_MENU_MIN_REACH);
  });

  test("is given back to the custom id, which has no list to open", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    openModelList();
    clickModelOption("Enter a custom model ID…");

    expect(fieldStack().style.minHeight).toBe("");
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
    // A statement, so nothing in it is a hit area either.
    expect(candidateCard("gemini").querySelector("label")).toBeNull();

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

    selectModel("Claude Opus 5");

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

  test("takes a click anywhere in the card, not only on the name", () => {
    renderCreate([
      makeConnection("anthropic-personal"),
      makeConnection("openrouter-key", "openrouter"),
    ]);

    selectModel("Claude Opus 5");
    expect(selectedCandidateValue()).toBe("anthropic");

    fireEvent.click(candidateRow("openrouter"));

    expect(selectedCandidateValue()).toBe("openrouter");
  });

  test("switching routes rewrites the model id for the new one", async () => {
    const saveCalls = renderCreate([
      makeConnection("anthropic-personal"),
      makeConnection("openrouter-key", "openrouter"),
    ]);

    selectModel("Claude Opus 5");
    pickCandidate("openrouter");

    await waitFor(() => {
      expect(getSaveBtn().disabled).toBe(false);
    });
    fireEvent.click(getSaveBtn());
    await waitFor(() => {
      expect(saveCalls.length).toBe(1);
    });
    expect(saveCalls[0].entry.provider).toBe("openrouter");
    expect(saveCalls[0].entry.model).toBe("anthropic/claude-opus-5");
  });

  test("names the key a route with siblings would use", () => {
    renderCreate([
      makeConnection("anthropic-work"),
      makeConnection("anthropic-personal", "anthropic", { label: "Personal" }),
    ]);

    selectModel("Claude Opus 5");

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

    selectModel("Claude Opus 5");
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

    selectModel("Claude Opus 5");
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
    expect(saveCalls[0].entry.model).toBe("anthropic/claude-opus-5");
    expect(saveCalls[0].entry.provider_connection).toBe("openrouter-key");
    // The Name still comes from the model's display name, not its raw id.
    expect(saveCalls[0].name).toBe("claude-opus-5");
  });

  test("re-keys the connect form when the lone route changes", () => {
    // Ollama is a local runtime, so only a self-hosted assistant offers it.
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "self_hosted" },
    });
    renderCreate([makeConnection("anthropic-personal")]);

    selectModel("Gemini 3.6 Flash");
    expect(candidateValues()).toEqual(["gemini"]);
    openCreateFormAdvanced();
    expect(getInputByPlaceholder("e.g. My Anthropic Key").value).toBe(
      "Google Gemini",
    );

    // The step stays in its lone-route branch, so the form is only remounted
    // by its key. Without one it would still be creating a Gemini connection
    // while the card names Ollama, since it seeds itself from props at mount.
    selectModel("Llama 3.2");
    expect(candidateValues()).toEqual(["ollama"]);
    openCreateFormAdvanced();
    expect(getInputByPlaceholder("e.g. My Anthropic Key").value).toBe("Ollama");
    // Ollama authenticates with nothing, so no key is asked for either.
    expect(hasInputWithPlaceholder("Enter your API key")).toBe(false);
  });

  test("puts the tag that asked for a key away while the form is open", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    selectModel("Claude Opus 5");
    expect(candidateCard("openrouter").textContent).toContain("Add API key");

    pickCandidate("openrouter");

    // The form below the row is already the answer to what the tag asked
    // for, so the row states the route and nothing else.
    expect(candidateCard("openrouter").textContent).not.toContain(
      "Add API key",
    );
    // Only that route's tag: the others still say where they stand.
    expect(candidateCard("anthropic").textContent).toContain("Connected");

    fireEvent.click(inlineCancelButton());
    expect(candidateCard("openrouter").textContent).toContain("Add API key");
  });

  test("names its dismiss action apart from the dialog's Cancel", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    selectModel("Gemini 3.6 Flash");

    const dialogCancel = document.querySelector<HTMLButtonElement>(
      '[data-testid="modal-cancel-btn"]',
    );
    expect(dialogCancel?.textContent?.trim()).toBe("Cancel");
    expect(inlineCancelButton()).not.toBe(dialogCancel);
  });

  test("keeps a lone route reachable after its setup is cancelled", () => {
    renderCreate([makeConnection("anthropic-personal")]);

    selectModel("Gemini 3.6 Flash");
    expect(hasInputWithPlaceholder("Enter your API key")).toBe(true);

    fireEvent.click(inlineCancelButton());

    // The route stays selected and only its form collapses; the card's own
    // action is what reopens it, since a lone route has no radio to re-click.
    expect(candidateValues()).toEqual(["gemini"]);
    expect(hasInputWithPlaceholder("Enter your API key")).toBe(false);
    expect(setupActionButton().textContent?.trim()).toBe("Add API key");

    fireEvent.click(setupActionButton());
    expect(hasInputWithPlaceholder("Enter your API key")).toBe(true);
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

/** The provider-first flow's dropdown trigger, which the flag hides. */
function providerFirstTrigger(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-labelledby="profile-editor-provider-label"]',
  );
  if (!trigger) {
    throw new Error("expected the provider-first Provider dropdown");
  }
  return trigger;
}

describe("the managed route's annotation", () => {
  test("reads Recommended here, and stays Managed in the provider-first picker", () => {
    renderCreate([
      makeConnection("vellum-managed", "vellum"),
      makeConnection("anthropic-personal"),
    ]);

    // A custom id is served by every route, which is where the managed route
    // stands beside another and the annotation is drawn at all.
    selectModel("Enter a custom model ID…");
    fireEvent.change(getInputByPlaceholder("provider/model-id"), {
      target: { value: "someone/new-model" },
    });

    const vellum = candidateCard("vellum");
    expect(vellum.textContent).toContain("Recommended");
    expect(vellum.textContent).not.toContain("Managed");

    // The shared encoding keeps its own word wherever the provider is the
    // question, so the two flows cannot be quietly unified.
    cleanup();
    setModelFirstFlag(false);
    renderCreate([makeConnection("vellum-managed", "vellum")]);
    fireEvent.click(providerFirstTrigger());

    const managed = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((option) => optionLabel(option) === "Vellum");
    expect(managed?.textContent).toContain("Managed");
  });
});
