import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

import {
  mcpServer,
  oauthConnection,
  oauthProvider,
} from "../integration-test-fixtures";
import type { OAuthProvider } from "../integration-items";
import type { OAuthConnection } from "@/generated/api/types.gen";
import type { McpServerEntry } from "../mcp/mcp-api";

let seededProviders: OAuthProvider[] = [];
let seededConnections: OAuthConnection[] = [];
let seededServers: McpServerEntry[] = [];
let oauthFails = false;
let mcpFails = false;
let platformGate = "full";
let allowAdd = true;
let hydrated = true;
const setupConversation = mock(() => {});

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-123",
}));
mock.module("@/hooks/use-is-org-ready", () => ({ useIsOrgReady: () => true }));
mock.module("@/utils/conversation-navigation", () => ({
  navigateToNewConversation: setupConversation,
}));
mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: {
      mcpAddServer: () => allowAdd,
      hasHydrated: () => hydrated,
    },
  },
}));
const actualDaemonQueries = await import(
  "@/generated/daemon/@tanstack/react-query.gen"
);
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...actualDaemonQueries,
  oauthProvidersGetOptions: () => ({
    queryKey: ["oauth-providers"],
    queryFn: async () => {
      if (oauthFails) {
        throw new Error("OAuth unavailable");
      }
      return { providers: seededProviders };
    },
  }),
}));
const actualApiQueries = await import(
  "@/generated/api/@tanstack/react-query.gen"
);
mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  ...actualApiQueries,
  assistantsOauthConnectionsListOptions: () => ({
    queryKey: ["oauth-connections"],
    queryFn: async () => seededConnections,
  }),
}));
mock.module("@/hooks/use-platform-assistant-id", () => ({
  usePlatformAssistantId: () => ({
    platformAssistantId: platformGate === "full" ? "platform-123" : null,
    isLoading: false,
    error: null,
  }),
}));
const actualPlatformGate = await import("@/hooks/use-platform-gate");
mock.module("@/hooks/use-platform-gate", () => ({
  ...actualPlatformGate,
  usePlatformGate: () => platformGate,
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));
mock.module("@/domains/settings/mcp/mcp-catalog-api", () => ({
  fetchMcpCatalog: async () => ({ supportsConnect: false, entries: [] }),
  connectMcpCatalogEntry: async () => ({ serverId: "unused", created: false }),
}));
mock.module("@/domains/settings/mcp/mcp-api", () => ({
  fetchMcpServers: async () => {
    if (mcpFails) {
      throw new Error("MCP unavailable");
    }
    return { servers: seededServers };
  },
  fetchMcpToolsSummary: async () => ({ servers: [] }),
  addMcpServer: async () => {},
  updateMcpServer: async () => {},
  removeMcpServer: async () => {},
  reloadMcpServers: async () => {},
  startMcpAuth: async () => ({}),
  pollMcpAuthStatus: async () => ({}),
  cancelMcpAuth: async () => ({}),
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

afterEach(() => {
  cleanup();
  seededProviders = [];
  seededConnections = [];
  seededServers = [];
  oauthFails = false;
  mcpFails = false;
  platformGate = "full";
  allowAdd = true;
  hydrated = true;
  setupConversation.mockClear();
});

describe("IntegrationsPage", () => {
  test("legacy tab=mcp links show the unified list without tabs", async () => {
    seededProviders = [oauthProvider()];
    seededServers = [mcpServer()];
    render(<IntegrationsPage />, {
      wrapper: ({ children }) => (
        <Wrapper initialEntry="/assistant/settings/integrations?tab=mcp">
          {children}
        </Wrapper>
      ),
    });
    await screen.findByText("Notion");
    await screen.findByText("example-integration");
    expect(screen.queryByRole("tab")).toBeNull();
  });
  test("withholds unconnected channel grants but preserves existing accounts", async () => {
    seededProviders = [
      oauthProvider(),
      oauthProvider({ provider_key: "discord", display_name: "Discord" }),
    ];
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("Notion");
    expect(screen.queryByText("Discord")).toBeNull();
  });
  test("keeps an existing channel grant visible", async () => {
    seededProviders = [
      oauthProvider({ provider_key: "discord", display_name: "Discord" }),
    ];
    seededConnections = [oauthConnection({ provider: "discord" })];
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("Discord");
  });
  test("OAuth source failures do not hide MCP connections", async () => {
    oauthFails = true;
    seededServers = [mcpServer()];
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("example-integration");
    await screen.findByText(/Some OAuth integrations could not be loaded/);
  });
  test("MCP source failures do not hide OAuth providers", async () => {
    mcpFails = true;
    seededProviders = [oauthProvider()];
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("Notion");
    await screen.findByText(/MCP connections could not be loaded/);
  });
  test("MCP connections remain available without platform login", async () => {
    platformGate = "disabled";
    seededServers = [mcpServer()];
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByRole("button", { name: "Configure" });
  });
  test("search covers both sources", async () => {
    seededProviders = [oauthProvider()];
    seededServers = [mcpServer()];
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("Notion");
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search integrations" }),
      { target: { value: "example" } },
    );
    await waitFor(() => expect(screen.queryByText("Notion")).toBeNull());
    screen.getByText("example-integration");
  });
  test("custom setup preserves the assistant-guided feature fallback", async () => {
    allowAdd = false;
    render(<IntegrationsPage />, { wrapper: Wrapper });
    fireEvent.click(
      screen.getByRole("button", { name: "Add custom integration" }),
    );
    expect(setupConversation).toHaveBeenCalledTimes(1);
  });
  test("custom setup waits for feature hydration", () => {
    hydrated = false;
    render(<IntegrationsPage />, { wrapper: Wrapper });
    expect(
      (
        screen.getByRole("button", {
          name: "Add custom integration",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
