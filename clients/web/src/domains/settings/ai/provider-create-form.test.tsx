/**
 * Tests for `ProviderCreateForm` — the shared create-path form extracted
 * from `ProviderEditorContent`.
 *
 * The component owns the two-step create submit sequence:
 *   1. `secretsPost` — persist the entered API key under
 *      `credential/<service>/<field>` (sent as `<service>:<field>`).
 *   2. `inferenceProviderconnectionsPost` — create the connection with the
 *      assembled `CreateConnectionInput`, then hand the returned connection
 *      back to the consumer via `onCreated`.
 *
 * Auth is derived from the chosen provider (keyless → none, everything else
 * → api_key; ChatGPT is a subscription pseudo-provider whose connection is
 * created by the OAuth flow) — there is no auth-type control.
 *
 * We mock the generated daemon SDK (sdk.gen) at module scope via
 * module-level holders so each test can inspect the exact request bodies,
 * mirroring the mocking style in
 * `use-conversation-actions-archive-optimistic.test.tsx`. The credential
 * presence / list hooks are stubbed so the form doesn't fan out real
 * network queries during render.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Modal } from "@vellumai/design-library/components/modal";
import { createElement, type ReactNode } from "react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import type { ProviderConnection } from "@/generated/daemon/types.gen";
import * as sdkGen from "@/generated/daemon/sdk.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

interface SecretsPostCall {
  path: { assistant_id: string };
  body: { type: string; name: string; value: string };
}
interface CreateConnectionCall {
  path: { assistant_id: string };
  body: Record<string, unknown>;
}

let secretsPostCalls: SecretsPostCall[] = [];
let createConnectionCalls: CreateConnectionCall[] = [];
let createdConnection: ProviderConnection;
let createResponseOk = true;
let createResponseStatus = 200;
let toastSuccessCalls: string[] = [];
const initialLifecycleState = useAssistantLifecycleStore.getState();

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
  secretsPost: (opts: SecretsPostCall) => {
    secretsPostCalls.push(opts);
    return Promise.resolve({ data: undefined, response: { ok: true } });
  },
  inferenceProviderconnectionsPost: (opts: CreateConnectionCall) => {
    createConnectionCalls.push(opts);
    return Promise.resolve({
      data: createResponseOk ? createdConnection : undefined,
      response: { ok: createResponseOk, status: createResponseStatus },
    });
  },
}));

// Stub the credential hooks so render doesn't issue real daemon queries.
// `hasStoredCredential: false` matches the empty create-mode state.
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

const { ProviderCreateForm } =
  await import("@/domains/settings/ai/provider-create-form");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSISTANT_ID = "asst-1";

function makeConnection(name: string): ProviderConnection {
  return {
    name,
    label: null,
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    models: null,
  } as unknown as ProviderConnection;
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

/**
 * The `variant="modal"` form renders `Modal.Content` (a Radix Dialog
 * portal), which requires a `Modal.Root` ancestor — exactly how
 * `ProviderEditorContent` embeds it. Wrap modal-variant renders so the
 * portal mounts.
 */
function ModalWrapper({ children }: { children: ReactNode }) {
  return (
    <Wrapper>
      <Modal.Root open>{children}</Modal.Root>
    </Wrapper>
  );
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
    throw new Error(
      `expected a "${label}" button — saw: ${Array.from(
        document.querySelectorAll("button"),
      )
        .map((b) => `"${b.textContent?.trim()}"`)
        .join(", ")}`,
    );
  }
  return match;
}

/**
 * Display Name (and, for openai-compatible, the Key) live under a collapsed
 * "Advanced" disclosure. Open it so those inputs mount before a test reads
 * or edits them. Idempotent — a no-op when the section is already expanded.
 */
function openAdvancedFields(): void {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === "Advanced");
  if (!button) {
    throw new Error("expected the Advanced disclosure");
  }
  if (button.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(button);
  }
}

/**
 * Drive the design-library Dropdown (a custom combobox, not a native
 * <select>): click the trigger to open the listbox, then click the option
 * whose visible label matches.
 */
function selectDropdownOption(ariaLabel: string, optionLabel: string): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[role="combobox"][aria-label="${ariaLabel}"]`,
  );
  if (!trigger) {
    throw new Error(`expected a "${ariaLabel}" dropdown trigger`);
  }
  fireEvent.click(trigger);
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === optionLabel);
  if (!option) {
    throw new Error(
      `expected an option "${optionLabel}" in the "${ariaLabel}" dropdown — saw: ${Array.from(
        document.querySelectorAll('[role="option"]'),
      )
        .map((o) => `"${o.textContent?.trim()}"`)
        .join(", ")}`,
    );
  }
  fireEvent.click(option);
}

beforeEach(() => {
  secretsPostCalls = [];
  createConnectionCalls = [];
  createdConnection = makeConnection("anthropic-personal");
  createResponseOk = true;
  createResponseStatus = 200;
  toastSuccessCalls = [];
  useAssistantLifecycleStore.setState(initialLifecycleState, true);
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProviderCreateForm submit sequence", () => {
  test("a keyed provider derives api_key auth: secretsPost then inferenceProviderconnectionsPost", async () => {
    let created: ProviderConnection | undefined;
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="anthropic"
          onCreated={(c) => {
            created = c;
          }}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    // No auth-type control: a keyed provider goes straight to the API key
    // field, and the connection name is seeded from the provider.
    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "sk-test-123" },
    });

    fireEvent.click(getButton("Add"));

    await waitFor(() => {
      expect(createConnectionCalls.length).toBe(1);
    });

    // secretsPost fired first with credential/<service>/<field> mapped to
    // `<service>:<field>`.
    expect(secretsPostCalls.length).toBe(1);
    expect(secretsPostCalls[0].path.assistant_id).toBe(ASSISTANT_ID);
    expect(secretsPostCalls[0].body).toEqual({
      type: "credential",
      name: "anthropic:api_key",
      value: "sk-test-123",
    });

    // Then inferenceProviderconnectionsPost with the full derived auth
    // object (NOT the bare `credential` field — older daemons only accept
    // explicit auth, and this form must work against them without a gate).
    expect(createConnectionCalls[0].path.assistant_id).toBe(ASSISTANT_ID);
    expect(createConnectionCalls[0].body).toMatchObject({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });

    // onCreated received the returned connection.
    await waitFor(() => {
      expect(created).toBeDefined();
    });
    expect(created?.name).toBe("anthropic-personal");
  });

  test("blocks a duplicate openai-compatible key with the validation message", () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={["my-endpoint"]}
          defaultProviderType="openai-compatible"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    openAdvancedFields();
    fireEvent.change(getInputByPlaceholder("e.g. my-endpoint"), {
      target: { value: "my-endpoint" },
    });

    expect(document.body.textContent).toContain(
      'A provider named "my-endpoint" already exists.',
    );
    expect(getButton("Add").disabled).toBe(true);
  });

  test("variant=inline renders the form without Modal chrome and still creates", async () => {
    let created: ProviderConnection | undefined;
    render(
      <Wrapper>
        <ProviderCreateForm
          variant="inline"
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="anthropic"
          onCreated={(c) => {
            created = c;
          }}
          onCancel={() => {}}
        />
      </Wrapper>,
    );

    // Inline variant drops the modal title.
    expect(document.body.textContent).not.toContain("Add Provider");

    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "sk-test-123" },
    });

    fireEvent.click(getButton("Add"));

    await waitFor(() => {
      expect(createConnectionCalls.length).toBe(1);
    });
    await waitFor(() => {
      expect(created?.name).toBe("anthropic-personal");
    });
  });

  test("there is no auth-type control — auth derives from the provider", () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="anthropic"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    expect(
      document.querySelector('button[role="combobox"][aria-label="Auth type"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("Auth Type");
    // Keyed provider → API key field present.
    expect(getInputByPlaceholder("Enter your API key")).toBeDefined();
  });

  test("Ollama creates a keyless connection without saving a secret", async () => {
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "self_hosted" },
    });
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="ollama"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    expect(
      Array.from(document.querySelectorAll<HTMLInputElement>("input")).some(
        (input) => input.placeholder === "Enter your API key",
      ),
    ).toBe(false);

    fireEvent.click(getButton("Add"));

    await waitFor(() => {
      expect(createConnectionCalls.length).toBe(1);
    });
    expect(secretsPostCalls).toEqual([]);
    expect(createConnectionCalls[0].body).toMatchObject({
      name: "ollama-personal",
      provider: "ollama",
      auth: { type: "none" },
    });
  });

  test("platform-hosted assistants ignore an Ollama default provider seed", () => {
    useAssistantLifecycleStore.setState({
      assistantState: { kind: "active", isLocal: false },
    });
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="ollama"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    // Ollama isn't selectable on platform-hosted assistants, so the picker
    // falls back to the first selectable provider — a keyed one, so the API
    // key field renders (adding a provider always means your own key now;
    // platform-managed routing is the Vellum row, not a per-provider choice).
    expect(getInputByPlaceholder("Enter your API key")).toBeDefined();
  });

  test("selecting ChatGPT shows the sign-in flow instead of Save", () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="anthropic"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    selectDropdownOption("Provider", "ChatGPT");

    // Subscription auth is owned by the OAuth flow: no API key field, no
    // Add button, sign-in affordance present.
    expect(
      Array.from(document.querySelectorAll<HTMLInputElement>("input")).some(
        (el) => el.placeholder === "Enter your API key",
      ),
    ).toBe(false);
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(
        (b) => b.textContent?.trim() === "Add",
      ),
    ).toBe(false);
    expect(document.body.textContent).toContain("ChatGPT");
  });

  test("fires a 'Provider connected' success toast on a successful create", async () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="anthropic"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "sk-test-123" },
    });

    fireEvent.click(getButton("Add"));

    await waitFor(() => {
      expect(toastSuccessCalls).toEqual(["Provider connected"]);
    });
  });

  test("a connection failure renders inline, keeps the form open, and does NOT toast", async () => {
    createResponseOk = false;
    createResponseStatus = 401;

    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="anthropic"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "sk-test-123" },
    });

    fireEvent.click(getButton("Add"));

    // The connection-failure message surfaces inline...
    await waitFor(() => {
      expect(createConnectionCalls.length).toBe(1);
    });
    expect(toastSuccessCalls).toEqual([]);
    // ...and the form stays mounted (the Add button is still present).
    expect(getButton("Add")).toBeDefined();
  });

  test("seeds Display Name from the provider and dedupes the key against existingNames", async () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={["anthropic-personal"]}
          defaultProviderType="anthropic"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    openAdvancedFields();
    expect(getInputByPlaceholder("e.g. My Anthropic Key").value).toBe(
      "Anthropic",
    );

    // The key is auto-derived (no input for keyed providers) — its deduped
    // value is observable in the POST body.
    fireEvent.change(getInputByPlaceholder("Enter your API key"), {
      target: { value: "sk-test-123" },
    });
    fireEvent.click(getButton("Add"));

    await waitFor(() => {
      expect(createConnectionCalls.length).toBe(1);
    });
    expect(createConnectionCalls[0].body).toMatchObject({
      name: "anthropic-personal-2",
      provider: "anthropic",
    });
  });

  test("changing the provider type re-seeds the Display Name", () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="anthropic"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    openAdvancedFields();
    selectDropdownOption("Provider", "OpenAI");

    expect(getInputByPlaceholder("e.g. My Anthropic Key").value).toBe("OpenAI");
  });

  test("a manual Display Name edit is NOT overwritten by a later provider-type change", () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="anthropic"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    openAdvancedFields();
    fireEvent.change(getInputByPlaceholder("e.g. My Anthropic Key"), {
      target: { value: "My Custom Name" },
    });

    selectDropdownOption("Provider", "OpenAI");

    expect(getInputByPlaceholder("e.g. My Anthropic Key").value).toBe(
      "My Custom Name",
    );
  });

  test("the key input only exists for openai-compatible", () => {
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          defaultProviderType="anthropic"
          onCreated={() => {}}
          onCancel={() => {}}
        />
      </ModalWrapper>,
    );

    const keyInputMounted = () =>
      Array.from(document.querySelectorAll<HTMLInputElement>("input")).some(
        (el) => el.placeholder === "e.g. my-endpoint",
      );

    openAdvancedFields();
    expect(keyInputMounted()).toBe(false);

    selectDropdownOption("Provider", "OpenAI-compatible");
    openAdvancedFields();
    expect(keyInputMounted()).toBe(true);
  });

  test("clicking Cancel invokes onCancel", () => {
    let cancelled = false;
    render(
      <ModalWrapper>
        <ProviderCreateForm
          assistantId={ASSISTANT_ID}
          existingNames={[]}
          onCreated={() => {}}
          onCancel={() => {
            cancelled = true;
          }}
        />
      </ModalWrapper>,
    );
    fireEvent.click(getButton("Cancel"));
    expect(cancelled).toBe(true);
  });
});
