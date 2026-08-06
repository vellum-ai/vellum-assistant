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

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

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

const { ProvidersSection } = await import(
  "@/domains/settings/ai/providers-section"
);
const { useAssistantIdentityStore } = await import(
  "@/stores/assistant-identity-store"
);

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

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function renderSection() {
  return render(
    <Wrapper>
      <ProvidersSection
        assistantId="asst-1"
        selectedConnectionName={null}
        onOpenConnection={() => {}}
        onAddProvider={() => {}}
        onConnectionDeleted={() => {}}
      />
    </Wrapper>,
  );
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
