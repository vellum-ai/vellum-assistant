import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

mock.module("@/assistant/api", () => ({
  getAssistant: mock(async () => ({
    ok: true,
    data: { id: "assistant-123" },
  })),
}));

let seededProviders: Array<Record<string, unknown>> = [];
let seededConnections: Array<Record<string, unknown>> = [];

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  oauthProvidersGetOptions: () => ({
    queryKey: ["oauth-providers"],
    queryFn: async () => ({ providers: seededProviders }),
  }),
}));

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  assistantsOauthConnectionsListOptions: () => ({
    queryKey: ["oauth-connections"],
    // The page reads this query with no `select`, so it is the connection
    // array itself, not an envelope around one.
    queryFn: async () => seededConnections,
  }),
}));

mock.module("@/hooks/use-platform-assistant-id", () => ({
  usePlatformAssistantId: () => ({
    platformAssistantId: "platform-assistant-123",
    isLoading: false,
  }),
}));

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "full",
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

mock.module("@/domains/settings/components/integration-detail-modal", () => ({
  IntegrationDetailModal: () => null,
}));

mock.module("@/domains/settings/components/integration-row", () => ({
  IntegrationRow: ({ providerKey }: { providerKey: string }) => (
    <div data-slot="integration-row">{providerKey}</div>
  ),
}));

mock.module("@/domains/settings/mcp/mcp-page", () => ({
  McpPage: () => <div>MCP tab content</div>,
}));

const { IntegrationsPage } = await import("./integrations-page");

function Wrapper({
  children,
  initialEntry = "/assistant/settings/integrations",
}: {
  children: ReactNode;
  initialEntry?: string;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function managedProvider(providerKey: string) {
  return {
    provider_key: providerKey,
    display_name: providerKey,
    description: null,
    logo_url: null,
    supports_managed_mode: true,
  };
}

/** Provider keys the catalog actually rendered a row for. */
function catalogRowKeys(): string[] {
  return Array.from(
    document.querySelectorAll('[data-slot="integration-row"]'),
  ).map((el) => el.textContent ?? "");
}

afterEach(() => {
  cleanup();
  seededProviders = [];
  seededConnections = [];
});

describe("IntegrationsPage", () => {
  test("renders OAuth and MCP tabs", () => {
    render(<IntegrationsPage />, {
      wrapper: ({ children }) => (
        <Wrapper initialEntry="/assistant/settings/integrations?tab=mcp">
          {children}
        </Wrapper>
      ),
    });

    expect(screen.getByRole("tab", { name: "OAuth" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "MCP" })).not.toBeNull();
  });

  test("withholds the discord card while listing the rest of the catalog", async () => {
    seededProviders = [
      managedProvider("google"),
      managedProvider("discord"),
      managedProvider("notion"),
    ];

    render(<IntegrationsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(catalogRowKeys()).toEqual(["google", "notion"]);
    });
  });

  test("keeps the discord card once it is connected, so it can be disconnected", async () => {
    // The catalog is the only surface that can disconnect an OAuth connection,
    // so hiding the card from someone who already has one would strand it.
    seededProviders = [managedProvider("discord")];
    seededConnections = [{ provider: "discord", connected: true }];

    render(<IntegrationsPage />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(catalogRowKeys()).toEqual(["discord"]);
    });
  });

  test("opens the MCP tab from the tab query parameter", () => {
    render(<IntegrationsPage />, {
      wrapper: ({ children }) => (
        <Wrapper initialEntry="/assistant/settings/integrations?tab=mcp">
          {children}
        </Wrapper>
      ),
    });

    expect(screen.getByText("MCP tab content")).not.toBeNull();
  });
});
