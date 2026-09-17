import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
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
let mcpAuthFails = false;
let assistantAvailable = true;
let platformGate = "full";
let allowAdd = true;
let hydrated = true;
let platformHosted = true;
let managedStatus: "idle" | "attempting" | "connected" = "attempting";
let managedError: string | null = null;
let selectedModalProvider: string | null = null;
let selectedModalTenantHost: unknown = null;
const setupConversation = mock(() => "draft-conversation");
const startLogin = mock(async () => {});
const managedConnect = mock((..._args: unknown[]) => {});
const managedDismiss = mock(() => {});
const installedPluginNames: string[] = [];
const authStarts: string[] = [];
const getAssistant = mock(async (assistantId?: string) =>
  assistantAvailable
    ? { ok: true, data: { id: assistantId ?? "stale-assistant" } }
    : { ok: false },
);

const assistantApiActual = await import("@/assistant/api");
mock.module("@/assistant/api", () => ({
  ...assistantApiActual,
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
  // Installing the plugin is what declares its MCP server, so the fake does
  // both: the connect sequence has nothing to authorize otherwise.
  usePluginsInstallPostMutation: () => ({
    mutateAsync: async (variables: { body: { name: string } }) => {
      const name = variables.body.name;
      installedPluginNames.push(name);
      seededPlugins = [...seededPlugins, installedPlugin({ name })];
      seededServers = [
        ...seededServers,
        server({
          id: `${name}-server`,
          source: "plugin",
          pluginName: name,
          status: "needs-auth",
        }),
      ];
      return {};
    },
    isPending: false,
    isError: false,
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
const platformGateActual = await import("@/hooks/use-platform-gate");
mock.module("@/hooks/use-platform-gate", () => ({
  ...platformGateActual,
  usePlatformGate: () => platformGate,
  useActiveAssistantIsPlatformHosted: () => platformHosted,
}));
mock.module("@/hooks/use-onboarding-login", () => ({
  useOnboardingLogin: () => ({
    loading: false,
    error: null,
    login: startLogin,
    cancel: () => {},
  }),
}));
mock.module("@/hooks/use-managed-oauth-connect", () => ({
  useManagedOAuthConnect: () => ({
    connect: managedConnect,
    dismiss: managedDismiss,
    status: managedStatus,
    connection: null,
    errorMessage: managedError,
  }),
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
// A desktop shell hands the authorization URL to the OS browser, so the
// attempt reaches its waiting phase without a popup jsdom cannot open.
mock.module("@/runtime/is-electron", () => ({ isElectron: () => true }));
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
  startMcpAuth: async (_assistantId: string, serverId: string) => {
    authStarts.push(serverId);
    if (mcpAuthFails) {
      throw new Error("MCP auth unavailable");
    }
    return { auth_url: "https://example.com/oauth", state: "state-123" };
  },
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

/**
 * Let whatever the last assertion started finish inside `act`: a live connect
 * attempt keeps polling, and a Radix menu measures itself after it opens.
 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
  mcpAuthFails = false;
  assistantAvailable = true;
  platformGate = "full";
  platformHosted = true;
  managedStatus = "attempting";
  managedError = null;
  allowAdd = true;
  hydrated = true;
  selectedModalProvider = null;
  selectedModalTenantHost = null;
  installedPluginNames.length = 0;
  authStarts.length = 0;
  setupConversation.mockClear();
  startLogin.mockClear();
  managedConnect.mockClear();
  managedDismiss.mockClear();
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

  test("connects an available MCP plugin from its own tile", async () => {
    seededCatalog = [catalogMatch()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Example");
    const connect = screen.getByRole("button", { name: "Connect Example" });
    // One action on the tile, and it is the one that connects.
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();

    fireEvent.click(connect);
    await waitFor(() => expect(installedPluginNames).toEqual(["example-mcp"]));
    await waitFor(() => expect(authStarts).toContain("example-mcp-server"));
    await screen.findByText("Finish signing in to Example in your browser.");
    await settle();
  });

  test("reports the sign-in in the tile that started it, and only there", async () => {
    seededCatalog = [catalogMatch()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Example");
    fireEvent.click(screen.getByRole("button", { name: "Connect Example" }));

    await screen.findByText("Finish signing in to Example in your browser.");
    screen.getByRole("button", { name: "Cancel" });
    // The page-level notice is for attempts a custom server card started.
    expect(
      screen.queryByText(/Waiting for you to authorize/),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop waiting" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Finish signing in to Example in your browser."),
      ).toBeNull(),
    );
    await settle();
  });

  test("offers the provider's setup guide when its sign-in fails", async () => {
    mcpAuthFails = true;
    seededCatalog = [catalogMatch()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Example");
    fireEvent.click(screen.getByRole("button", { name: "Connect Example" }));

    await screen.findByRole("button", { name: "Setup guide" });
    screen.getByRole("button", { name: "Retry connecting Example" });
    await settle();
  });

  test("starts a managed authorization from a tile with no other way in", async () => {
    seededProviders = [provider()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Notion");
    fireEvent.click(screen.getByRole("button", { name: "Connect Notion" }));

    await waitFor(() => expect(managedConnect).toHaveBeenCalledTimes(1));
    await screen.findByText("Finish signing in to Notion in your browser.");
    await settle();
  });

  test("gives a self-hosted assistant the split connect action", async () => {
    platformHosted = false;
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
    render(<IntegrationsPage />, { wrapper: Wrapper });

    const chevron = await screen.findByRole("button", {
      name: "Other ways to connect Notion",
    });
    screen.getByRole("button", { name: "Connect Notion" });

    // Radix opens a menu on pointer-down, not on a synthetic click.
    fireEvent.pointerDown(chevron, { button: 0, ctrlKey: false });
    for (const label of [
      "Notion MCP server",
      "Sign in through Vellum",
      "Use your own OAuth app",
    ]) {
      await screen.findByRole("menuitem", { name: label });
    }
    await settle();
  });

  test("leaves a custom server's sign-in on the page-level notice", async () => {
    seededServers = [server({ id: "custom-mcp", status: "needs-auth" })];
    seededCatalog = [catalogMatch()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("custom-mcp");
    fireEvent.click(screen.getByRole("button", { name: "Finish connecting" }));

    await screen.findByText(
      "Complete authorization for custom-mcp in the browser, then return here.",
    );
    // No tile owns it, so no tile draws it.
    expect(
      screen.queryByText("Finish signing in to Example in your browser."),
    ).toBeNull();
    await settle();
  });

  test("hands the sign-in back to the page notice when a search hides its tile", async () => {
    seededCatalog = [catalogMatch()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Example");
    fireEvent.click(screen.getByRole("button", { name: "Connect Example" }));
    await screen.findByText("Finish signing in to Example in your browser.");

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search integrations" }),
      { target: { value: "nothing matches this" } },
    );

    await screen.findByText(
      "Complete authorization for Example in the browser, then return here.",
    );
    screen.getByRole("button", { name: "Stop waiting" });
    await settle();
  });

  test("holds every other connect action while a managed authorization is open", async () => {
    seededProviders = [provider()];
    seededServers = [server({ id: "custom-mcp", status: "needs-auth" })];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Notion");
    fireEvent.click(screen.getByRole("button", { name: "Connect Notion" }));
    await waitFor(() => expect(managedConnect).toHaveBeenCalledTimes(1));

    // The rows and cards that predate the tiles gate on the MCP machine
    // alone, which a managed authorization never touches.
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Add custom integration",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Finish connecting",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await settle();
  });

  test("replaces a failed method with the alternative picked after it", async () => {
    mcpAuthFails = true;
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
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Notion");
    fireEvent.click(screen.getByRole("button", { name: "Connect Notion" }));
    await screen.findByRole("button", { name: "Setup guide" });

    // Radix opens a menu on pointer-down, not on a synthetic click.
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Try another way" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Sign in through Vellum" }),
    );

    await waitFor(() => expect(managedConnect).toHaveBeenCalledTimes(1));
    await screen.findByText("Finish signing in to Notion in your browser.");
    expect(screen.queryByRole("button", { name: "Setup guide" })).toBeNull();
    await settle();
  });

  test("keeps the other ways out of sight on a platform-hosted assistant", async () => {
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
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Notion");
    expect(
      screen.queryByRole("button", { name: "Other ways to connect Notion" }),
    ).toBeNull();
  });

  test("sends a connect with no platform session to the login flow", async () => {
    platformGate = "disabled";
    seededProviders = [provider()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Notion");
    fireEvent.click(screen.getByRole("button", { name: "Connect Notion" }));
    await waitFor(() => expect(startLogin).toHaveBeenCalledTimes(1));
    expect(managedConnect).not.toHaveBeenCalled();
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
