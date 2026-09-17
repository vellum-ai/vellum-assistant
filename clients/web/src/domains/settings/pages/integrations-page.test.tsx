import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useNavigate } from "react-router";

import type { OAuthConnection } from "@/generated/api/types.gen";
import type {
  OauthProvidersGetResponse,
  PluginsGetResponse,
  PluginsSearchGetResponse,
} from "@/generated/daemon/types.gen";
import { conversationNavigationMock } from "@/utils/conversation-navigation.test-helper";
import type { McpServerEntry } from "../mcp/mcp-api";

type OAuthProvider = OauthProvidersGetResponse["providers"][number];
type CatalogMatch = PluginsSearchGetResponse["matches"][number];
type InstalledPlugin = PluginsGetResponse["plugins"][number];

let seededProviders: OAuthProvider[] = [];
let seededConnections: OAuthConnection[] = [];
let seededServers: McpServerEntry[] = [];
let seededCatalog: CatalogMatch[] = [];
let seededPlugins: InstalledPlugin[] = [];
let oauthFails = false;
let mcpFails = false;
let pluginCatalogFails = false;
let pluginListFails = false;
let assistantAvailable = true;
let platformGate = "full";
let allowAdd = true;
let hydrated = true;
let selectedModalProvider: string | null = null;
let selectedModalTenantHost: unknown = null;
const setupConversation = mock(() => "draft-conversation");
const getAssistant = mock(async (assistantId?: string) =>
  assistantAvailable
    ? { ok: true, data: { id: assistantId ?? "stale-assistant" } }
    : { ok: false },
);

mock.module("@/assistant/api", () => ({
  getAssistant,
}));
mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "mcp-assistant-123",
}));
mock.module("@/utils/conversation-navigation", () =>
  conversationNavigationMock({ navigateToNewConversation: setupConversation }),
);
mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: {
      mcpAddServer: () => allowAdd,
      hasHydrated: () => hydrated,
    },
  },
}));
const daemonReactQueryActual = await import(
  "@/generated/daemon/@tanstack/react-query.gen"
);
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...daemonReactQueryActual,
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
const apiReactQueryActual = await import(
  "@/generated/api/@tanstack/react-query.gen"
);
mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  ...apiReactQueryActual,
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
mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => platformGate,
}));
mock.module("@/hooks/use-plugins-list", () => ({
  usePluginsList: () => ({
    isLoading: false,
    isError: pluginListFails,
    installedLoaded: !pluginListFails || seededPlugins.length > 0,
    catalogError: pluginCatalogFails,
    catalogMatches: seededCatalog,
    installedPlugins: seededPlugins,
  }),
}));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));
mock.module("@/runtime/browser", () => ({
  openExternalUrl: async () => {},
  openUrlFinishedListener: () => () => {},
}));
mock.module("@/domains/settings/components/integration-detail-modal", () => ({
  IntegrationDetailModal: (props: {
    providerKey: string;
    tenantHost: unknown;
    onClose: () => void;
  }) => {
    selectedModalProvider = props.providerKey;
    selectedModalTenantHost = props.tenantHost;
    return (
      <div>
        OAuth detail modal
        <button type="button" onClick={props.onClose}>
          Close OAuth detail modal
        </button>
      </div>
    );
  },
}));
mock.module("@/domains/settings/components/integration-methods-modal", () => ({
  IntegrationMethodsModal: (props: {
    item: { name: string };
    onClose: () => void;
  }) => (
    <div>
      Methods for {props.item.name}
      <button type="button" onClick={props.onClose}>
        Close methods
      </button>
    </div>
  ),
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
  startMcpAuth: async () => ({
    auth_url: "https://example.com/oauth",
    state: "state-123",
  }),
  pollMcpAuthStatus: async () => ({ status: "pending" }),
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

function ProviderNavigationButton() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() =>
        navigate("/assistant/settings/integrations?provider=notion")
      }
    >
      Open provider deep link
    </button>
  );
}

function provider(overrides: Partial<OAuthProvider> = {}): OAuthProvider {
  return {
    provider_key: "notion",
    display_name: "Notion",
    description: "Workspace notes",
    dashboard_url: null,
    client_id_placeholder: null,
    requires_client_secret: true,
    logo_url: null,
    supports_managed_mode: true,
    managed_service_is_paid: false,
    feature_flag: null,
    tenant_host: null,
    acts_as: "user",
    ...overrides,
  };
}

function connection(overrides: Partial<OAuthConnection> = {}): OAuthConnection {
  return {
    id: "connection-1",
    provider: "notion",
    status: "ACTIVE",
    connected: true,
    account_label: "user@example.com",
    scopes_granted: [],
    expires_at: null,
    ...overrides,
  };
}

function server(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    id: "example-integration",
    status: "connected",
    transport: {
      type: "streamable-http",
      url: "https://mcp.example.com/mcp",
    },
    hasOAuth: false,
    hasStaticAuth: false,
    authType: "none",
    ...overrides,
  };
}

function catalogMatch(overrides: Partial<CatalogMatch> = {}): CatalogMatch {
  return {
    name: "example-mcp",
    path: "local:example-mcp@1.0.0",
    description: "Example tools",
    category: "productivity",
    source: { kind: "local", path: "example-mcp", version: "1.0.0" },
    integration: {
      kind: "mcp",
      displayName: "Example",
      documentationUrl: "https://example.com/docs",
      verifiedAt: "2026-09-15",
      verification: "documentation-only",
      setup: { mode: "oauth", instructions: "Sign in to Example." },
      logo: "example.png",
    },
    ...overrides,
  };
}

function installedPlugin(
  overrides: Partial<InstalledPlugin> = {},
): InstalledPlugin {
  return {
    id: "plugin-example-mcp",
    name: "example-mcp",
    enabled: true,
    description: "Example tools",
    version: "1.0.0",
    category: "productivity",
    hasIcon: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  seededProviders = [];
  seededConnections = [];
  seededServers = [];
  seededCatalog = [];
  seededPlugins = [];
  oauthFails = false;
  mcpFails = false;
  pluginCatalogFails = false;
  pluginListFails = false;
  assistantAvailable = true;
  platformGate = "full";
  allowAdd = true;
  hydrated = true;
  selectedModalProvider = null;
  selectedModalTenantHost = null;
  setupConversation.mockClear();
  getAssistant.mockClear();
});

afterAll(() => mock.restore());

describe("IntegrationsPage", () => {
  test("legacy tab=mcp links show one list without tabs", async () => {
    seededProviders = [provider()];
    seededServers = [server()];
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
    expect(getAssistant).toHaveBeenCalledWith("mcp-assistant-123");
  });

  test("keeps configured recovery rows separate from available providers", async () => {
    seededProviders = [provider()];
    seededConnections = [connection({ status: "ERROR", connected: false })];
    seededServers = [server({ status: "error" })];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByRole("heading", { name: /Your integrations 2/ });
    expect(screen.queryByRole("heading", { name: /Available/ })).toBeNull();
    expect(screen.getAllByText("Needs attention")).toHaveLength(2);
  });

  test("withholds unconnected channel grants but preserves existing accounts", async () => {
    seededProviders = [
      provider(),
      provider({ provider_key: "discord", display_name: "Discord" }),
    ];
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("Notion");
    expect(screen.queryByText("Discord")).toBeNull();

    cleanup();
    seededProviders = [
      provider({ provider_key: "discord", display_name: "Discord" }),
    ];
    seededConnections = [connection({ provider: "discord" })];
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("Discord");
  });

  test("OAuth source failures do not hide MCP connections", async () => {
    oauthFails = true;
    seededServers = [server()];
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("example-integration");
    await screen.findByText(/OAuth integrations could not be loaded/);
  });

  test("missing OAuth assistant metadata does not gate MCP", async () => {
    assistantAvailable = false;
    seededServers = [server()];
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("example-integration");
    await screen.findByText(/OAuth integrations could not be loaded/);
  });

  test("MCP source failures do not hide OAuth providers", async () => {
    mcpFails = true;
    seededProviders = [provider()];
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("Notion");
    await screen.findByText(/MCP connections could not be loaded/);
  });

  test("plugin catalog failures do not hide existing integrations", async () => {
    pluginCatalogFails = true;
    seededProviders = [provider()];
    seededServers = [server()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Notion");
    screen.getByText("example-integration");
    screen.getByText(/Plugin integrations could not be loaded/);
  });

  test("shows explicit catalog metadata as an available plugin integration", async () => {
    seededCatalog = [catalogMatch()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Example");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("Methods for Example");
  });

  test("groups an installed plugin with its mapped provider", async () => {
    seededProviders = [provider()];
    seededCatalog = [
      catalogMatch({
        name: "notion-mcp",
        integration: {
          ...catalogMatch().integration!,
          displayName: "Notion",
          oauthProvider: "notion",
          logo: "notion.png",
        },
      }),
    ];
    seededPlugins = [installedPlugin({ name: "notion-mcp" })];
    seededServers = [
      server({
        id: "notion-tools",
        source: "plugin",
        pluginName: "notion-mcp",
        status: "needs-auth",
      }),
    ];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Notion");
    expect(screen.getAllByText("Notion")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Configure Notion" }));
    await screen.findByText("Methods for Notion");
  });

  test("MCP connections remain available without platform login", async () => {
    platformGate = "disabled";
    seededServers = [server()];
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("example-integration");
    screen.getByRole("button", { name: "Configure example-integration" });
  });

  test("search covers both sources", async () => {
    seededProviders = [provider()];
    seededServers = [server()];
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("Notion");
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search integrations" }),
      { target: { value: "example" } },
    );
    await waitFor(() => expect(screen.queryByText("Notion")).toBeNull());
    screen.getByText("example-integration");
  });

  test("provider deep links preserve tenant-host configuration", async () => {
    const tenantHost = {
      pattern: "^[a-z0-9-]+\\.example\\.com$",
      label: "Store domain",
      placeholder: "store.example.com",
    };
    seededProviders = [provider({ tenant_host: tenantHost })];
    render(<IntegrationsPage />, {
      wrapper: ({ children }) => (
        <Wrapper initialEntry="/assistant/settings/integrations?provider=notion">
          {children}
        </Wrapper>
      ),
    });

    await screen.findByText("OAuth detail modal");
    expect(selectedModalProvider).toBe("notion");
    expect(selectedModalTenantHost).toEqual(tenantHost);
  });

  test("provider deep links open after the unified page is already mounted", async () => {
    seededProviders = [provider()];
    render(
      <>
        <IntegrationsPage />
        <ProviderNavigationButton />
      </>,
      { wrapper: Wrapper },
    );

    await screen.findByText("Notion");
    expect(screen.queryByText("OAuth detail modal")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Open provider deep link" }),
    );
    await screen.findByText("OAuth detail modal");
    expect(selectedModalProvider).toBe("notion");
  });

  test("closing a provider deep link allows the same link to reopen", async () => {
    seededProviders = [provider()];
    render(
      <>
        <IntegrationsPage />
        <ProviderNavigationButton />
      </>,
      {
        wrapper: ({ children }) => (
          <Wrapper initialEntry="/assistant/settings/integrations?provider=notion">
            {children}
          </Wrapper>
        ),
      },
    );

    await screen.findByText("OAuth detail modal");
    fireEvent.click(
      screen.getByRole("button", { name: "Close OAuth detail modal" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("OAuth detail modal")).toBeNull(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open provider deep link" }),
    );
    await screen.findByText("OAuth detail modal");
  });

  test("custom setup preserves the assistant-guided feature fallback", async () => {
    allowAdd = false;
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("No integrations are available.");
    fireEvent.click(
      screen.getByRole("button", { name: "Add custom integration" }),
    );
    expect(setupConversation).toHaveBeenCalledTimes(1);
  });

  test("custom setup waits for feature hydration", async () => {
    hydrated = false;
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("No integrations are available.");
    expect(
      (screen.getByRole("button", {
        name: "Add custom integration",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
