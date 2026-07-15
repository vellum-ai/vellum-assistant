/**
 * Tests for `ManageProvidersModal` — the "use as default" marker (M7 PR 2).
 *
 * Mocks the generated SDK boundary; the default-provider GET/PUT flow runs
 * through the real generated react-query wrappers.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";

import type {
  DefaultProviderStatus,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let connectionsState: ProviderConnection[] = [];
let defaultProviderState: DefaultProviderStatus = {
  provider: null,
  resolvedConnectionName: null,
  availability: { status: "missing_default" },
};
let defaultProviderGetCalls = 0;
let putBodies: Array<{ provider: string; connectionName?: string }> = [];
let putShouldFail = false;
let deleteCalls: string[] = [];
let deleteResult: { status: number; body?: unknown } = { status: 200 };
let capturedErrors: unknown[] = [];

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: (error: unknown) => {
    capturedErrors.push(error);
  },
}));

const actualSdk = await import("@/generated/daemon/sdk.gen");

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...actualSdk,
  inferenceProviderconnectionsGet: async () => ({
    data: { connections: connectionsState },
  }),
  configLlmDefaultproviderGet: async () => {
    defaultProviderGetCalls += 1;
    return { data: defaultProviderState };
  },
  configLlmDefaultproviderPut: async (options?: {
    body?: { provider: string; connectionName?: string };
  }) => {
    if (options?.body) {
      putBodies.push(options.body);
    }
    if (putShouldFail) {
      throw new Error("put failed");
    }
    defaultProviderState = {
      provider: (options?.body?.provider ??
        null) as DefaultProviderStatus["provider"],
      connectionName: options?.body?.connectionName,
      resolvedConnectionName: options?.body?.connectionName ?? null,
      availability: { status: "ok" },
    };
    return { data: defaultProviderState };
  },
  inferenceProviderconnectionsByNameDelete: async (options?: {
    path?: { name?: string };
  }) => {
    if (options?.path?.name) {
      deleteCalls.push(options.path.name);
    }
    return {
      error: deleteResult.body,
      response: {
        ok: deleteResult.status >= 200 && deleteResult.status < 300,
        status: deleteResult.status,
      },
    };
  },
  configGet: async () => ({ data: {} }),
}));

const { ManageProvidersModal } =
  await import("@/domains/settings/ai/manage-providers-modal");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConnection(
  overrides: Partial<ProviderConnection> & { name: string; provider: string },
): ProviderConnection {
  return {
    label: null,
    auth: {
      type: "api_key",
      credential: `credential/${overrides.provider}/api_key`,
    },
    baseUrl: null,
    models: null,
    createdAt: 1,
    updatedAt: 1,
    isManaged: false,
    ...overrides,
  } as ProviderConnection;
}

function renderModal() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ManageProvidersModal, {
        isOpen: true,
        assistantId: "assistant-1",
        onClose: () => {},
      }),
    ),
  );
}

function rowFor(result: ReturnType<typeof render>, providerTitle: string) {
  const title = Array.from(
    result.baseElement.querySelectorAll<HTMLElement>("span"),
  ).find((element) => element.textContent?.trim() === providerTitle);
  if (!title) {
    throw new Error(`Provider "${providerTitle}" not found`);
  }
  return title.closest("div.flex.items-center.gap-3")?.parentElement ?? null;
}

async function waitForRow(
  result: ReturnType<typeof render>,
  providerTitle: string,
) {
  await waitFor(() => {
    expect(rowFor(result, providerTitle)).not.toBeNull();
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  connectionsState = [];
  defaultProviderState = {
    provider: null,
    resolvedConnectionName: null,
    availability: { status: "missing_default" },
  };
  defaultProviderGetCalls = 0;
  putBodies = [];
  putShouldFail = false;
  deleteCalls = [];
  deleteResult = { status: 200 };
  capturedErrors = [];
  // The marker UI is version-gated (assistants < 0.10.8 lack the routes).
  useAssistantIdentityStore.getState().setIdentity("test-asst", "0.10.8");
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("default marker", () => {
  test("renders the Default tag on the resolved connection and disables its delete", async () => {
    connectionsState = [
      makeConnection({ name: "anthropic-personal", provider: "anthropic" }),
      makeConnection({ name: "openai-personal", provider: "openai" }),
    ];
    defaultProviderState = {
      provider: "anthropic",
      resolvedConnectionName: "anthropic-personal",
      availability: { status: "ok" },
    };

    const result = renderModal();
    await waitFor(() => {
      expect(result.baseElement.textContent).toContain("Default");
    });

    const defaultRow = rowFor(result, "Anthropic");
    expect(defaultRow?.textContent).toContain("Default");
    const otherRow = rowFor(result, "OpenAI");
    expect(otherRow?.textContent).not.toContain("Default");

    const deleteButton = defaultRow?.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Anthropic"]',
    );
    expect(deleteButton?.disabled).toBe(true);
    expect(deleteButton?.title).toContain("default provider");
  });

  test("Set as default PUTs explicit provider + connectionName and moves the tag", async () => {
    connectionsState = [
      makeConnection({ name: "anthropic-personal", provider: "anthropic" }),
      makeConnection({ name: "work-openai", provider: "openai" }),
    ];
    defaultProviderState = {
      provider: "anthropic",
      resolvedConnectionName: "anthropic-personal",
      availability: { status: "ok" },
    };

    const result = renderModal();
    await waitForRow(result, "OpenAI");

    const otherRow = rowFor(result, "OpenAI");
    const setDefaultButton = [
      ...(otherRow?.querySelectorAll("button") ?? []),
    ].find((b) => b.textContent === "Set as default");
    expect(setDefaultButton).toBeDefined();
    fireEvent.click(setDefaultButton as HTMLButtonElement);

    await waitFor(() => {
      expect(putBodies).toEqual([
        { provider: "openai", connectionName: "work-openai" },
      ]);
    });

    // Invalidation refetches the GET (now pointing at work-openai) and the
    // tag moves to the new row.
    await waitFor(() => {
      const refreshedRow = rowFor(result, "OpenAI");
      expect(refreshedRow?.textContent).toContain("Default");
    });
  });

  test("non-matrix providers get a disabled action with an explanatory tooltip", async () => {
    connectionsState = [
      makeConnection({ name: "local-ollama", provider: "ollama" }),
    ];

    const result = renderModal();
    await waitForRow(result, "Ollama");

    const row = rowFor(result, "Ollama");
    const setDefaultButton = [...(row?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Set as default",
    );
    expect((setDefaultButton as HTMLButtonElement).disabled).toBe(true);
    expect((setDefaultButton as HTMLButtonElement).title).toContain(
      "can't run on this provider",
    );
    expect(putBodies).toEqual([]);
  });

  test("assistants without the routes get no marker UI and no query", async () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.10.7");
    connectionsState = [
      makeConnection({ name: "openai-personal", provider: "openai" }),
    ];

    const result = renderModal();
    await waitForRow(result, "OpenAI");

    expect(result.baseElement.textContent).not.toContain("Set as default");
    expect(result.baseElement.textContent).not.toContain("Default");
    expect(defaultProviderGetCalls).toBe(0);
  });

  test("PUT failure renders the inline row error", async () => {
    connectionsState = [
      makeConnection({ name: "openai-personal", provider: "openai" }),
    ];
    putShouldFail = true;

    const result = renderModal();
    await waitForRow(result, "OpenAI");

    const row = rowFor(result, "OpenAI");
    const setDefaultButton = [...(row?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Set as default",
    );
    fireEvent.click(setDefaultButton as HTMLButtonElement);

    await waitFor(() => {
      expect(result.baseElement.textContent).toContain(
        "Failed to set default provider",
      );
    });
  });
});

describe("card titles", () => {
  test("titles a ChatGPT subscription row distinctly from OpenAI API-key rows", async () => {
    // GIVEN unlabeled ChatGPT subscription and OpenAI API-key providers
    connectionsState = [
      makeConnection({
        name: "chatgpt-subscription",
        provider: "openai",
        auth: {
          type: "oauth_subscription",
          credential: "credential/chatgpt/access_token",
        },
      }),
      makeConnection({ name: "openai-personal", provider: "openai" }),
    ];

    // WHEN the provider list renders
    const result = renderModal();
    await waitFor(() => {
      expect(result.baseElement.textContent).toContain("ChatGPT Subscription");
    });

    // THEN each provider has a distinct title without internal-key subtitles
    const apiKeyRow = rowFor(result, "OpenAI");
    expect(apiKeyRow?.textContent).toContain("OpenAI");
    expect(apiKeyRow?.textContent).not.toContain("ChatGPT");
    expect(result.baseElement.textContent).not.toContain(
      "chatgpt-subscription",
    );
    expect(result.baseElement.textContent).not.toContain("openai-personal");
    expect(
      result.baseElement.querySelector(
        'button[aria-label="Delete ChatGPT Subscription"]',
      ),
    ).not.toBeNull();
    expect(
      result.baseElement.querySelector(
        'button[aria-label="Delete openai-personal"]',
      ),
    ).toBeNull();
  });
});

describe("delete-guard errors", () => {
  async function clickDelete(name: string) {
    connectionsState = [makeConnection({ name, provider: "openai" })];
    const result = renderModal();
    await waitForRow(result, "OpenAI");
    const deleteButton = result.baseElement.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete OpenAI"]',
    );
    await act(async () => {
      fireEvent.click(deleteButton as HTMLButtonElement);
    });
    return result;
  }

  test("409 renders a user-facing guard without internal provider names", async () => {
    deleteResult = {
      status: 409,
      body: {
        error: {
          code: "CONFLICT",
          message:
            'Connection "work-openai" is referenced by llm.defaultProvider. Update llm.defaultProvider before deleting.',
          details: { referencedBy: ["llm.defaultProvider"] },
        },
      },
    };

    const result = await clickDelete("work-openai");
    await waitFor(() => {
      expect(result.baseElement.textContent).toContain(
        "This provider is in use by a profile or as the default provider",
      );
    });
    expect(result.baseElement.textContent).not.toContain("work-openai");
    expect(result.baseElement.textContent).not.toContain("llm.defaultProvider");
  });

  test("non-guarded connections still delete cleanly", async () => {
    deleteResult = { status: 200 };

    const result = await clickDelete("work-openai");
    await waitFor(() => {
      expect(deleteCalls).toEqual(["work-openai"]);
    });
    expect(result.baseElement.textContent).not.toContain("Failed to delete");
  });

  test("set-default failure reports to Sentry via captureError", async () => {
    putShouldFail = true;
    connectionsState = [
      makeConnection({ name: "openai-personal", provider: "openai" }),
    ];

    const result = renderModal();
    await waitForRow(result, "OpenAI");
    const setDefaultButton = [
      ...result.baseElement.querySelectorAll("button"),
    ].find((b) => b.textContent === "Set as default");
    fireEvent.click(setDefaultButton as HTMLButtonElement);

    await waitFor(() => {
      expect(capturedErrors.length).toBe(1);
    });
  });
});

describe("editability", () => {
  function editButtonFor(
    result: ReturnType<typeof render>,
    providerTitle: string,
  ): HTMLButtonElement | undefined {
    const row = rowFor(result, providerTitle);
    return [...(row?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Edit",
    ) as HTMLButtonElement | undefined;
  }

  test("managed (Vellum) connections expose no Edit affordance", async () => {
    // GIVEN a platform-managed connection alongside a user-owned one
    connectionsState = [
      makeConnection({ name: "vellum", provider: "vellum", isManaged: true }),
      makeConnection({ name: "anthropic-personal", provider: "anthropic" }),
    ];

    // WHEN the modal renders
    const result = renderModal();
    await waitForRow(result, "Anthropic");

    // THEN the managed row has no Edit button, but the user-owned one does
    expect(editButtonFor(result, "Vellum")).toBeUndefined();
    expect(editButtonFor(result, "Anthropic")).toBeDefined();
  });

  test("the editor identifies providers without exposing their internal names", async () => {
    connectionsState = [
      makeConnection({
        name: "ollama-personal",
        provider: "ollama",
        auth: { type: "none" },
      }),
    ];

    const result = renderModal();
    await waitForRow(result, "Ollama");
    fireEvent.click(editButtonFor(result, "Ollama") as HTMLButtonElement);

    await waitFor(() => {
      expect(result.baseElement.textContent).toContain("Editing Ollama.");
    });
    expect(result.baseElement.textContent).not.toContain("ollama-personal");
  });
});
