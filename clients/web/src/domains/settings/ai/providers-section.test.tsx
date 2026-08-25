/**
 * Tests for `ProvidersSection` - the inline Providers list of the Language
 * Model card.
 *
 * The Default chip tracks the resolved default connection and its kebab
 * hides Delete; Set as default PUTs the explicit provider + connectionName;
 * assistants without the default-provider routes get no marker UI and no
 * status query; the managed Vellum row pins first with a Managed chip and
 * no edit affordance; delete guards (409) surface as user-facing toasts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import type {
  DefaultProviderStatus,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let connectionsState: ProviderConnection[] = [];
let connectionsResponder: () => Promise<{
  data: { connections: ProviderConnection[] };
}> = async () => ({ data: { connections: connectionsState } });
let connectionsRequestCount = 0;
let defaultProviderState: DefaultProviderStatus = {
  provider: null,
  resolvedConnectionName: null,
  availability: { status: "missing_default" },
};
let defaultProviderGetCalls = 0;
let putBodies: Array<{ provider: string; connectionName?: string }> = [];
let deleteCalls: string[] = [];
let deleteStatus = 200;
let toastErrors: string[] = [];

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: () => {},
    error: (message: string) => {
      toastErrors.push(message);
    },
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

const actualSdk = await import("@/generated/daemon/sdk.gen");

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...actualSdk,
  inferenceProviderconnectionsGet: async () => {
    connectionsRequestCount += 1;
    return connectionsResponder();
  },
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
    return { data: defaultProviderState, response: { ok: true } };
  },
  inferenceProviderconnectionsByNameDelete: async (options?: {
    path?: { name?: string };
  }) => {
    deleteCalls.push(options?.path?.name ?? "");
    return {
      response: { ok: deleteStatus < 400, status: deleteStatus },
    };
  },
}));

const STUB_TIMEOUT_MS = 30;

class StubRequestTimeoutError extends Error {
  readonly timeoutMs = STUB_TIMEOUT_MS;

  constructor() {
    super(`Request timed out after ${STUB_TIMEOUT_MS}ms`);
    this.name = "RequestTimeoutError";
  }
}

class StubRequestAbortedError extends Error {
  constructor() {
    super("Request aborted");
    this.name = "RequestAbortedError";
  }
}

mock.module("@/utils/request-timeout", () => ({
  RequestAbortedError: StubRequestAbortedError,
  RequestTimeoutError: StubRequestTimeoutError,
  runWithRequestTimeout: <T,>({
    run,
  }: {
    run: (signal: AbortSignal) => Promise<T>;
  }) => {
    const controller = new AbortController();
    const running = run(controller.signal);
    running.catch(() => {});
    return Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          const error = new StubRequestTimeoutError();
          controller.abort(error);
          reject(error);
        }, STUB_TIMEOUT_MS);
      }),
    ]);
  },
}));

const { ProvidersSection } =
  await import("@/domains/settings/ai/providers-section");
const { getDiagnosticsEvents } = await import("@/lib/diagnostics");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function connection(
  overrides: Partial<ProviderConnection> & { name: string },
): ProviderConnection {
  return {
    label: null,
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    models: null,
    ...overrides,
  } as ProviderConnection;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
}

function renderSection(client = createQueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <ProvidersSection
        assistantId="asst-1"
        selectedConnectionName={null}
        onOpenConnection={() => {}}
        onAddProvider={() => {}}
        onConnectionDeleted={() => {}}
      />
    </QueryClientProvider>,
  );
}

function skeletons(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="skeleton"]'),
  );
}

function retryButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Retry",
  );
}

function providerDiagnostics(from: number) {
  return getDiagnosticsEvents()
    .slice(from)
    .filter((event) => event.kind.startsWith("provider_connections_"));
}

function rows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="list-row"]'),
  );
}

async function openKebab(displayName: string): Promise<HTMLElement> {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[aria-label="Actions for ${displayName}"]`,
  );
  if (!trigger) {
    throw new Error(`expected a kebab trigger for "${displayName}"`);
  }
  act(() => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    trigger.click();
  });
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>('[role="menu"]');
    if (!el) {
      throw new Error("menu did not open");
    }
    return el;
  });
}

function menuItems(menu: HTMLElement): string[] {
  return Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
    (el) => el.textContent?.trim() ?? "",
  );
}

function clickMenuItem(menu: HTMLElement, label: string): void {
  const item = Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
    (el) => el.textContent?.trim() === label,
  );
  if (!item) {
    throw new Error(`expected menu item "${label}"`);
  }
  act(() => {
    (item as HTMLElement).click();
  });
}

function seedConnections() {
  connectionsState = [
    connection({
      name: "anthropic-personal",
      provider: "anthropic",
    }),
    connection({
      name: "vellum",
      provider: "vellum",
      isManaged: true,
      auth: { type: "platform" } as ProviderConnection["auth"],
    }),
    connection({
      name: "local-ollama",
      provider: "ollama",
      auth: { type: "none" } as ProviderConnection["auth"],
    }),
  ];
}

beforeEach(() => {
  seedConnections();
  connectionsResponder = async () => ({
    data: { connections: connectionsState },
  });
  connectionsRequestCount = 0;
  defaultProviderState = {
    provider: "anthropic",
    resolvedConnectionName: "anthropic-personal",
    availability: { status: "ok" },
  };
  defaultProviderGetCalls = 0;
  putBodies = [];
  deleteCalls = [];
  deleteStatus = 200;
  toastErrors = [];
  useAssistantIdentityStore.getState().setIdentity("test-asst", "0.11.0");
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  useAssistantIdentityStore.getState().clearIdentity();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProvidersSection - rows and chips", () => {
  test("renders Vellum first with a Managed chip and no open affordance", async () => {
    renderSection();
    await waitFor(() => {
      expect(rows().length).toBe(3);
    });
    const first = rows()[0];
    expect(first.textContent).toContain("Vellum");
    expect(first.textContent).toContain("Managed");
    expect(first.textContent).toContain("Included with your plan");
    expect(
      document.querySelector('button[aria-label="Open provider Vellum"]'),
    ).toBeNull();
  });

  test("the Default chip sits on the resolved connection; Local marks Ollama", async () => {
    renderSection();
    await waitFor(() => {
      expect(rows().length).toBe(3);
    });
    const anthropicRow = rows().find((r) =>
      r.textContent?.includes("Anthropic"),
    );
    const ollamaRow = rows().find((r) => r.textContent?.includes("Ollama"));
    expect(anthropicRow?.textContent).toContain("Default");
    expect(anthropicRow?.textContent).toContain("Own API key");
    expect(ollamaRow?.textContent).toContain("Local");
    expect(ollamaRow?.textContent).toContain("No API key needed");
    expect(ollamaRow?.textContent).not.toContain("Default");
  });

  test("assistants without the default-provider routes get no marker UI and no status query", async () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.10.7");
    renderSection();
    await waitFor(() => {
      expect(rows().length).toBe(3);
    });
    expect(document.body.textContent).not.toContain("Default");
    expect(defaultProviderGetCalls).toBe(0);
    const menu = await openKebab("Anthropic");
    expect(menuItems(menu)).not.toContain("Set as default");
  });
});

describe("ProvidersSection - bounded request lifecycle", () => {
  test("a stalled request leaves the skeletons for a retryable error", async () => {
    connectionsResponder = () => new Promise(() => {});

    renderSection();
    expect(skeletons().length).toBe(3);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Failed to load providers");
    });
    expect(skeletons().length).toBe(0);
    expect(retryButton()).toBeDefined();
  });

  test("Retry renders the fresh request result", async () => {
    connectionsResponder = () => new Promise(() => {});
    renderSection();
    await waitFor(() => {
      expect(retryButton()).toBeDefined();
    });

    connectionsState = [
      connection({ name: "openrouter-key", provider: "openrouter" }),
      connection({
        name: "vellum",
        provider: "vellum",
        isManaged: true,
        auth: { type: "platform" } as ProviderConnection["auth"],
      }),
    ];
    connectionsResponder = async () => ({
      data: { connections: connectionsState },
    });

    act(() => {
      retryButton()?.click();
    });

    await waitFor(() => {
      expect(rows().length).toBe(2);
    });
    expect(rows()[0]?.textContent).toContain("Vellum");
    expect(rows()[1]?.textContent).toContain("OpenRouter");
    expect(document.body.textContent).not.toContain("Failed to load providers");
    expect(connectionsRequestCount).toBe(2);
  });

  test("a timeout stays actionable through mount, focus, and reconnect", async () => {
    connectionsResponder = () => new Promise(() => {});
    const client = createQueryClient();
    renderSection(client);
    await waitFor(() => {
      expect(retryButton()).toBeDefined();
    });
    expect(connectionsRequestCount).toBe(1);

    connectionsResponder = async () => ({
      data: { connections: connectionsState },
    });

    renderSection(client);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });

    expect(connectionsRequestCount).toBe(1);
    expect(skeletons().length).toBe(0);
    expect(retryButton()).toBeDefined();
  });

  test("a stalled request records a client timeout without payload data", async () => {
    connectionsResponder = () => new Promise(() => {});
    const from = getDiagnosticsEvents().length;

    renderSection();
    await waitFor(() => {
      expect(retryButton()).toBeDefined();
    });

    const diagnostics = providerDiagnostics(from);
    const kinds = diagnostics.map((event) => event.kind);
    expect(kinds[0]).toBe("provider_connections_query_invoked");
    expect(kinds).toContain("provider_connections_request_dispatched");
    expect(kinds.at(-1)).toBe("provider_connections_client_timeout");
    expect(diagnostics.at(-1)?.details).toMatchObject({
      assistantId: "asst-1",
      timeoutMs: STUB_TIMEOUT_MS,
    });
    const details = JSON.stringify(diagnostics.map((event) => event.details));
    expect(details).not.toContain("credential");
    expect(details).not.toContain("auth");
    expect(details).not.toContain("anthropic-personal");
  });

  test("a rejected request records an error instead of a timeout", async () => {
    connectionsResponder = () =>
      Promise.reject(new Error("provider connections unavailable"));
    const from = getDiagnosticsEvents().length;

    renderSection();

    await waitFor(() => {
      expect(providerDiagnostics(from).map((event) => event.kind)).toContain(
        "provider_connections_error_received",
      );
    });
    const diagnostics = providerDiagnostics(from);
    expect(diagnostics.map((event) => event.kind)).not.toContain(
      "provider_connections_client_timeout",
    );
    expect(diagnostics.at(-1)?.details.errorName).toBe("Error");
    expect(
      JSON.stringify(diagnostics.map((event) => event.details)),
    ).not.toContain("unavailable");
  });
});

describe("ProvidersSection - kebab actions", () => {
  test("Set as default PUTs the explicit provider + connectionName", async () => {
    defaultProviderState = {
      provider: "vellum",
      resolvedConnectionName: "vellum",
      availability: { status: "ok" },
    };
    renderSection();
    await waitFor(() => {
      expect(rows().length).toBe(3);
    });
    const menu = await openKebab("Anthropic");
    clickMenuItem(menu, "Set as default");
    await waitFor(() => {
      expect(putBodies).toEqual([
        { provider: "anthropic", connectionName: "anthropic-personal" },
      ]);
    });
  });

  test("an ineligible provider offers no Set as default", async () => {
    renderSection();
    await waitFor(() => {
      expect(rows().length).toBe(3);
    });
    const menu = await openKebab("Ollama");
    const items = menuItems(menu);
    expect(items).not.toContain("Set as default");
    expect(items).toContain("Edit");
    expect(items).toContain("Delete");
  });

  test("the default connection's kebab hides Delete", async () => {
    renderSection();
    await waitFor(() => {
      expect(rows().length).toBe(3);
    });
    const menu = await openKebab("Anthropic");
    const items = menuItems(menu);
    expect(items).toContain("Edit");
    expect(items).not.toContain("Delete");
  });

  test("the managed row's kebab carries only Set as default", async () => {
    renderSection();
    await waitFor(() => {
      expect(rows().length).toBe(3);
    });
    const menu = await openKebab("Vellum");
    expect(menuItems(menu)).toEqual(["Set as default"]);
  });

  test("delete calls the DELETE route for the connection", async () => {
    renderSection();
    await waitFor(() => {
      expect(rows().length).toBe(3);
    });
    const menu = await openKebab("Ollama");
    clickMenuItem(menu, "Delete");
    await waitFor(() => {
      expect(deleteCalls).toEqual(["local-ollama"]);
    });
    expect(toastErrors).toEqual([]);
  });

  test("a 409 delete guard surfaces a user-facing message without internal names", async () => {
    deleteStatus = 409;
    renderSection();
    await waitFor(() => {
      expect(rows().length).toBe(3);
    });
    const menu = await openKebab("Ollama");
    clickMenuItem(menu, "Delete");
    await waitFor(() => {
      expect(toastErrors.length).toBe(1);
    });
    expect(toastErrors[0]).toContain("in use by a profile");
    expect(toastErrors[0]).not.toContain("local-ollama");
  });
});
