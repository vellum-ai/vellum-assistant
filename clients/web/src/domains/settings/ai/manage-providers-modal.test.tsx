/**
 * Tests for `ManageProvidersModal`'s default-provider marker: the "Default"
 * tag on the resolved connection, the delete guard on that row, and the
 * "Set as default" action that pins the clicked connection explicitly.
 *
 * Mocks the generated SDK boundary (connections list, default-provider
 * GET/PUT) per the domain's test convention.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";

import type {
  DefaultProviderStatus,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

let connectionsState: ProviderConnection[] = [];
let defaultProviderState: DefaultProviderStatus;
let putBodies: unknown[] = [];
let putShouldFail = false;
let defaultProviderGetCalls = 0;

mock.module("@/generated/daemon/sdk.gen", () => ({
  inferenceProviderconnectionsGet: async () => ({
    data: { connections: connectionsState },
  }),
  configLlmDefaultproviderGet: async () => {
    defaultProviderGetCalls += 1;
    return { data: defaultProviderState };
  },
  configLlmDefaultproviderPut: async (options?: { body?: unknown }) => {
    if (putShouldFail) {
      throw new Error("boom");
    }
    putBodies.push(options?.body);
    return { data: defaultProviderState };
  },
  inferenceProviderconnectionsByNameDelete: async () => ({
    response: { ok: true, status: 200 },
  }),
  configGet: async () => ({ data: { llm: {} } }),
}));

import { ManageProvidersModal } from "./manage-providers-modal";

function makeConnection(
  overrides: Partial<ProviderConnection> & { name: string; provider: string },
): ProviderConnection {
  return {
    label: null,
    auth: { type: "api_key", credential: `credential/${overrides.provider}/api_key` },
    baseUrl: null,
    models: null,
    createdAt: 0,
    updatedAt: 0,
    isManaged: false,
    ...overrides,
  } as ProviderConnection;
}

function renderModal() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ManageProvidersModal, {
        isOpen: true,
        assistantId: "asst-1",
        onClose: () => {},
      }),
    ),
  );
}

beforeEach(() => {
  putBodies = [];
  putShouldFail = false;
  defaultProviderGetCalls = 0;
  connectionsState = [
    makeConnection({ name: "anthropic", provider: "anthropic" }),
    makeConnection({ name: "openai-personal", provider: "openai" }),
    makeConnection({
      name: "local-ollama",
      provider: "ollama",
      auth: { type: "none" } as ProviderConnection["auth"],
    }),
  ];
  defaultProviderState = {
    provider: "anthropic",
    connectionName: "anthropic",
    resolvedConnectionName: "anthropic",
    availability: { status: "ok" },
  };
});

afterEach(() => {
  cleanup();
});

describe("default-provider marker", () => {
  test("renders the Default tag on the resolved connection and guards its delete", async () => {
    const { findByText, getByLabelText } = renderModal();
    await findByText("Default");
    const deleteButton = getByLabelText(
      "Delete anthropic",
    ) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    expect(deleteButton.title).toContain("serves your default provider");
  });

  test("Set as default pins the clicked connection's provider AND name explicitly", async () => {
    const { findAllByText } = renderModal();
    const buttons = await findAllByText("Set as default");
    // Rows render in connections order; the first non-default eligible row
    // is openai-personal.
    fireEvent.click(buttons[0]!);
    await waitFor(() => {
      expect(putBodies).toHaveLength(1);
    });
    expect(putBodies[0]).toEqual({
      provider: "openai",
      connectionName: "openai-personal",
    });
    // The marker refreshes from the server, not from local state.
    await waitFor(() => {
      expect(defaultProviderGetCalls).toBeGreaterThan(1);
    });
  });

  test("non-matrix providers get a disabled action with an explanatory tooltip", async () => {
    const { findAllByText } = renderModal();
    const buttons = (await findAllByText(
      "Set as default",
    )) as HTMLButtonElement[];
    const ollamaButton = buttons.find((b) =>
      b.title.includes("Built-in profiles"),
    );
    expect(ollamaButton).toBeDefined();
    expect(ollamaButton!.disabled).toBe(true);
  });

  test("a PUT failure renders the inline row error", async () => {
    putShouldFail = true;
    const { findAllByText, findByText } = renderModal();
    const buttons = await findAllByText("Set as default");
    fireEvent.click(buttons[0]!);
    await findByText("Failed to set the default provider. Please try again.");
  });

  test("no Default tag renders when the default's connection is not in the list", async () => {
    defaultProviderState = {
      provider: "gemini",
      resolvedConnectionName: "gemini-personal",
      availability: { status: "missing_connection", message: "…" },
    };
    const { queryByText, findByText } = renderModal();
    await findByText("anthropic");
    expect(queryByText("Default")).toBeNull();
  });
});
