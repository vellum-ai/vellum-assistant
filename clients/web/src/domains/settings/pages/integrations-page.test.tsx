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
let mcpAuthCompletes = false;
let heldPluginRemoval: (() => void) | null = null;
let holdPluginRemoval = false;
let assistantAvailable = true;
let platformGate = "full";
let allowAdd = true;
let hydrated = true;
let platformHosted = true;
let managedStatus: "idle" | "attempting" | "connected" = "attempting";
let managedError: string | null = null;
let seededTools: {
  serverId: string;
  toolCount: number;
  estimatedTokens: number;
  tools: { name: string; description: string; estimatedTokens: number }[];
}[] = [];
const setupConversation = mock(() => "draft-conversation");
const startLogin = mock(async () => {});
const managedConnect = mock((..._args: unknown[]) => {});
const managedDismiss = mock(() => {});
const installedPluginNames: string[] = [];
const removedPluginNames: string[] = [];
const disconnectedConnectionIds: string[] = [];
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
const daemonReactQueryActual =
  await import("@/generated/daemon/@tanstack/react-query.gen");
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
      // The daemon refuses an existing install rather than reusing it, so a
      // path that installs what is already there has to fail here too.
      if (seededPlugins.some((plugin) => plugin.name === name)) {
        throw new Error(`Plugin "${name}" is already installed.`);
      }
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
  // Uninstalling takes the plugin's declared servers with it, so the fake
  // does both: the card has to leave Your integrations on its own.
  usePluginsByNameDeleteMutation: (options?: {
    onSuccess?: (
      result: unknown,
      variables: { path: { name: string } },
    ) => void;
  }) => ({
    mutate: (variables: { path: { name: string } }) => {
      const name = variables.path.name;
      const settle = () => {
        removedPluginNames.push(name);
        seededPlugins = seededPlugins.filter((plugin) => plugin.name !== name);
        seededServers = seededServers.filter(
          (entry) => entry.pluginName !== name,
        );
        options?.onSuccess?.({}, variables);
      };
      // A removal the test holds open stands for the window between the
      // request and its answer, which is where a second connect would land.
      if (holdPluginRemoval) {
        heldPluginRemoval = settle;
        return;
      }
      settle();
    },
    isPending: false,
    isError: false,
  }),
}));
const apiReactQueryActual =
  await import("@/generated/api/@tanstack/react-query.gen");
mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  ...apiReactQueryActual,
  assistantsOauthConnectionsListOptions: () => ({
    queryKey: ["oauth-connections"],
    queryFn: async () => seededConnections,
  }),
  useAssistantsOauthDisconnectByConnectionCreateMutation: () => ({
    mutate: (variables: { path: { connection_id: string } }) => {
      disconnectedConnectionIds.push(variables.path.connection_id);
    },
    isPending: false,
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
mock.module("@/domains/settings/mcp/mcp-api", () => ({
  fetchMcpServers: async () => {
    if (mcpFails) {
      throw new Error("MCP unavailable");
    }
    return { servers: seededServers };
  },
  fetchMcpToolsSummary: async () => ({ servers: seededTools }),
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
  pollMcpAuthStatus: async () => ({
    status: mcpAuthCompletes ? "complete" : "pending",
  }),
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

/**
 * Call off the sign-in from the tile's action slot.
 *
 * The slot spends the wait as a spinner and turns into an X once a mouse
 * arrives on it, so a test that means to cancel arrives the same way a mouse
 * does. A finger gets a second press instead, which is the whole point of it
 * on a touch screen.
 */
function cancelFromTile(name: string) {
  const button = screen.getByRole("button", {
    name: `Cancel connecting ${name}`,
  });
  fireEvent.pointerEnter(button, { pointerType: "mouse" });
  fireEvent.click(button, { detail: 1 });
}

/** Radix opens a menu on pointer-down, not on a synthetic click. */
function openTileMenu(name: string) {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: `Other ways to connect ${name}` }),
    { button: 0, ctrlKey: false },
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
    category: "productivity",
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
      category: "meetings",
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
  seededTools = [];
  oauthFails = false;
  mcpFails = false;
  pluginCatalogFails = false;
  pluginListFails = false;
  mcpAuthFails = false;
  mcpAuthCompletes = false;
  holdPluginRemoval = false;
  heldPluginRemoval = null;
  assistantAvailable = true;
  platformGate = "full";
  platformHosted = true;
  managedStatus = "attempting";
  managedError = null;
  allowAdd = true;
  hydrated = true;
  installedPluginNames.length = 0;
  removedPluginNames.length = 0;
  disconnectedConnectionIds.length = 0;
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

  test("an unreadable server list leaves connected plugins where they are", async () => {
    mcpFails = true;
    seededCatalog = [catalogMatch()];
    seededPlugins = [installedPlugin()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    // Without the list there is no telling an unauthorized plugin from one
    // whose servers simply did not arrive, so the install is trusted and the
    // integration keeps its place.
    await screen.findByText(/MCP connections could not be loaded/);
    await screen.findByRole("heading", { name: /Your integrations/ });
    screen.getByRole("button", { name: "Configure Example" });
    expect(screen.queryByText("Needs attention")).toBeNull();
    await settle();
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
    screen.getByRole("button", { name: "Cancel connecting Example" });
    // The page-level notice is for attempts a custom server card started.
    expect(screen.queryByText(/Waiting for you to authorize/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop waiting" })).toBeNull();

    cancelFromTile("Example");
    await waitFor(() =>
      expect(
        screen.queryByText("Finish signing in to Example in your browser."),
      ).toBeNull(),
    );
    await settle();
  });

  test("cancelling a sign-in takes back the plugin it installed", async () => {
    seededCatalog = [catalogMatch()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Example");
    fireEvent.click(screen.getByRole("button", { name: "Connect Example" }));
    await waitFor(() => expect(installedPluginNames).toEqual(["example-mcp"]));
    await screen.findByText("Finish signing in to Example in your browser.");

    cancelFromTile("Example");

    // The install only happened to reach a sign-in that never did, so the
    // integration goes back to how it was found: on offer, with nothing to
    // attend to and no half-connected plugin behind it.
    await waitFor(() => expect(removedPluginNames).toEqual(["example-mcp"]));
    await screen.findByRole("heading", { name: /Available/ });
    expect(
      screen.queryByRole("heading", { name: /Your integrations/ }),
    ).toBeNull();
    expect(screen.queryByText("Needs attention")).toBeNull();
    screen.getByRole("button", { name: "Connect Example" });
    await settle();
  });

  test("cancelling before the install lands still takes it back", async () => {
    seededCatalog = [catalogMatch()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Example");
    // The cancel is clicked in the same tick as the connect, so the install
    // request has not settled yet. The removal waits for it rather than
    // missing it.
    fireEvent.click(screen.getByRole("button", { name: "Connect Example" }));
    cancelFromTile("Example");

    await waitFor(() => expect(installedPluginNames).toEqual(["example-mcp"]));
    await waitFor(() => expect(removedPluginNames).toEqual(["example-mcp"]));
    await settle();
  });

  test("giving up the wait after the grant lands keeps the plugin", async () => {
    // The sign-in completed and the connection is coming up. The plugin holds
    // credentials the user just gave it, so giving up on watching it must not
    // take them away again.
    mcpAuthCompletes = true;
    // A manual setup runs in the dialog, which is the surface that can still
    // stop a wait this far along.
    seededCatalog = [
      catalogMatch({
        integration: {
          ...catalogMatch().integration!,
          setup: { mode: "manual", instructions: "Allowlist the callback." },
        },
      }),
    ];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Example");
    fireEvent.click(screen.getByRole("button", { name: "Connect Example" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(installedPluginNames).toEqual(["example-mcp"]));

    await screen.findByText("Connecting to Example...");
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));

    await settle();
    expect(removedPluginNames).toEqual([]);
  });

  test("a cancelled connect cannot restart until its removal settles", async () => {
    holdPluginRemoval = true;
    seededCatalog = [catalogMatch()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Example");
    fireEvent.click(screen.getByRole("button", { name: "Connect Example" }));
    await waitFor(() => expect(installedPluginNames).toEqual(["example-mcp"]));
    await screen.findByText("Finish signing in to Example in your browser.");
    cancelFromTile("Example");

    // The removal is in flight. A connect over it would be handed the plugin
    // that removal is on its way to taking, so the tile waits for it.
    const connect = await screen.findByRole("button", {
      name: "Connect Example",
    });
    await waitFor(() =>
      expect((connect as HTMLButtonElement).disabled).toBe(true),
    );
    fireEvent.click(connect);
    expect(authStarts).toEqual(["example-mcp-server"]);

    act(() => heldPluginRemoval?.());
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Connect Example",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await settle();
  });

  test("cancelling a reconnect keeps the plugin that predates it", async () => {
    seededCatalog = [catalogMatch()];
    seededPlugins = [installedPlugin()];
    seededServers = [
      server({
        id: "example-server",
        source: "plugin",
        pluginName: "example-mcp",
        status: "needs-auth",
        hasOAuth: true,
      }),
    ];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByRole("heading", { name: /Your integrations/ });
    fireEvent.click(screen.getByRole("button", { name: "Configure Example" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await screen.findByText(
      "Finish signing in to Example in your browser, then come back here.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Nothing was installed for this attempt, so nothing is taken away: the
    // integration the user already had survives giving up on signing in again.
    await waitFor(() =>
      expect(
        screen.queryByText(
          "Finish signing in to Example in your browser, then come back here.",
        ),
      ).toBeNull(),
    );
    expect(removedPluginNames).toEqual([]);
    expect(installedPluginNames).toEqual([]);
    await settle();
  });

  test("offers the provider's setup guide when its sign-in fails", async () => {
    mcpAuthFails = true;
    seededCatalog = [catalogMatch()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Example");
    fireEvent.click(screen.getByRole("button", { name: "Connect Example" }));

    await screen.findByRole("button", { name: "Retry connecting Example" });
    // The guide is behind the retry's chevron, where it costs the tile no
    // height and the row of tiles beside it none either.
    openTileMenu("Example");
    await screen.findByRole("menuitem", { name: "Setup guide" });
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
    await screen.findByRole("button", { name: "Retry connecting Notion" });

    openTileMenu("Notion");
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Sign in through Vellum" }),
    );

    await waitFor(() => expect(managedConnect).toHaveBeenCalledTimes(1));
    await screen.findByText("Finish signing in to Notion in your browser.");
    expect(
      screen.queryByRole("button", { name: "Retry connecting Notion" }),
    ).toBeNull();
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
        hasOAuth: true,
      }),
    ];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Notion");
    expect(screen.getAllByText("Notion")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Configure Notion" }));
    await screen.findByText("Manage how Vellum connects to Notion.");
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

  test("category chips narrow the catalog and clear on a second click", async () => {
    seededProviders = [provider()];
    seededCatalog = [catalogMatch()];
    seededServers = [server()];
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("Notion");
    await screen.findByText("Example");

    const chips = screen.getByRole("group", { name: "Filter by category" });
    // The catalog's order, not the page's, and only what it files something under.
    expect(
      Array.from(chips.querySelectorAll("button")).map(
        (chip) => chip.textContent,
      ),
    ).toEqual(["Productivity1", "Meetings1"]);

    fireEvent.click(screen.getByRole("button", { name: "Meetings 1" }));
    await waitFor(() => expect(screen.queryByText("Notion")).toBeNull());
    screen.getByText("Example");
    // A custom server is filed nowhere, so a chip hides it too.
    expect(screen.queryByText("example-integration")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Meetings 1" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Meetings 1" }));
    await screen.findByText("Notion");
    screen.getByText("example-integration");
  });

  test("a chip with a search that matches nothing says which category is empty", async () => {
    seededProviders = [provider()];
    render(<IntegrationsPage />, { wrapper: Wrapper });
    await screen.findByText("Notion");

    fireEvent.click(screen.getByRole("button", { name: "Productivity 1" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search integrations" }),
      { target: { value: "nothing matches this" } },
    );
    await screen.findByText('No integrations matched "nothing matches this"');
  });

  test("provider deep links ask a per-tenant provider for its host", async () => {
    seededProviders = [
      provider({
        tenant_host: {
          pattern: "^[a-z0-9-]+\\.example\\.com$",
          label: "Store domain",
          placeholder: "store.example.com",
        },
      }),
    ];
    render(<IntegrationsPage />, {
      wrapper: ({ children }) => (
        <Wrapper initialEntry="/assistant/settings/integrations?provider=notion">
          {children}
        </Wrapper>
      ),
    });

    const host = await screen.findByLabelText("Store domain");
    // Nothing to authorize until the merchant says whose domain it is.
    expect(
      (screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.change(host, { target: { value: "shop.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(managedConnect).toHaveBeenCalledTimes(1));
    expect(managedConnect).toHaveBeenCalledWith(undefined, "shop.example.com");
    await settle();
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
    expect(screen.queryByText("Connect Notion")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Open provider deep link" }),
    );
    await screen.findByRole("heading", { name: "Connect Notion" });
    await settle();
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

    await screen.findByRole("heading", { name: "Connect Notion" });
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]!);
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Connect Notion" }),
      ).toBeNull(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open provider deep link" }),
    );
    await screen.findByRole("heading", { name: "Connect Notion" });
    await settle();
  });

  test("a deep link to a connected provider opens on what it has", async () => {
    seededProviders = [provider()];
    seededConnections = [connection()];
    render(<IntegrationsPage />, {
      wrapper: ({ children }) => (
        <Wrapper initialEntry="/assistant/settings/integrations?provider=notion">
          {children}
        </Wrapper>
      ),
    });

    await screen.findByText("Manage how Vellum connects to Notion.");
    screen.getByText("user@example.com");
    await settle();
  });

  test("the gear on a connected integration opens its connections", async () => {
    seededProviders = [provider()];
    seededConnections = [connection()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByRole("heading", { name: /Your integrations/ });
    fireEvent.click(screen.getByRole("button", { name: "Configure Notion" }));

    await screen.findByText("Manage how Vellum connects to Notion.");
    screen.getByText("user@example.com");
    await settle();
  });

  test("disconnecting a managed account revokes it at the platform", async () => {
    seededProviders = [provider()];
    seededConnections = [connection()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByRole("heading", { name: /Your integrations/ });
    fireEvent.click(screen.getByRole("button", { name: "Configure Notion" }));
    await screen.findByText("user@example.com");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove user@example.com" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(disconnectedConnectionIds).toEqual(["connection-1"]),
    );
    await settle();
  });

  test("disconnecting an MCP row uninstalls the plugin behind it", async () => {
    seededCatalog = [catalogMatch()];
    seededPlugins = [installedPlugin()];
    seededServers = [
      server({
        id: "example-server",
        source: "plugin",
        pluginName: "example-mcp",
      }),
    ];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByRole("heading", { name: /Your integrations/ });
    fireEvent.click(screen.getByRole("button", { name: "Configure Example" }));
    await screen.findByText("Manage how Vellum connects to Example.");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Example MCP server" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(removedPluginNames).toEqual(["example-mcp"]));
    // Nothing is left to manage, so the dialog asks how to connect instead.
    await screen.findByRole("heading", { name: "Connect Example" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // The card goes back to Available on its own, with no reload.
    await screen.findByRole("heading", { name: /Available/ });
    expect(
      screen.queryByRole("heading", { name: /Your integrations/ }),
    ).toBeNull();
    await settle();
  });

  test("reconnect signs the same server in and shows it in the dialog", async () => {
    seededCatalog = [catalogMatch()];
    seededPlugins = [installedPlugin()];
    seededServers = [
      server({
        id: "example-server",
        source: "plugin",
        pluginName: "example-mcp",
        status: "needs-auth",
        hasOAuth: true,
      }),
    ];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByRole("heading", { name: /Your integrations/ });
    fireEvent.click(screen.getByRole("button", { name: "Configure Example" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));

    // The server it already has, not a fresh install of the plugin.
    await waitFor(() => expect(authStarts).toEqual(["example-server"]));
    expect(installedPluginNames).toEqual([]);
    await screen.findByText(
      "Finish signing in to Example in your browser, then come back here.",
    );
    await settle();
  });

  test("a reconnect leaves a connected integration where it is", async () => {
    seededCatalog = [catalogMatch()];
    seededPlugins = [installedPlugin()];
    seededServers = [
      server({
        id: "example-server",
        source: "plugin",
        pluginName: "example-mcp",
        status: "needs-auth",
        hasOAuth: true,
      }),
    ];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByRole("heading", { name: /Your integrations/ });
    fireEvent.click(screen.getByRole("button", { name: "Configure Example" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await screen.findByText(
      "Finish signing in to Example in your browser, then come back here.",
    );

    // The dialog is drawing the sign-in, so the card does not move to
    // Available under it. The open dialog hides the page from the role
    // queries, so the sections are read through it.
    screen.getByRole("heading", { name: /Your integrations/, hidden: true });
    expect(
      screen.queryByRole("heading", { name: /Available/, hidden: true }),
    ).toBeNull();
    await settle();
  });

  test("reconnecting a declared server signs in without reinstalling", async () => {
    seededCatalog = [catalogMatch()];
    seededPlugins = [installedPlugin()];
    seededServers = [
      server({
        id: "example-server",
        source: "plugin",
        pluginName: "example-mcp",
        status: "needs-auth",
        hasOAuth: true,
      }),
    ];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByRole("heading", { name: /Your integrations/ });
    fireEvent.click(screen.getByRole("button", { name: "Configure Example" }));
    await screen.findByText("Manage how Vellum connects to Example.");

    // The plugin installs once, so its server is not on offer a second time:
    // the row it already has is where a stalled sign-in is finished.
    expect(
      screen.queryByRole("button", { name: "Connect another" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    // The install would be refused, so the attempt goes straight to the
    // server the plugin already declared.
    await waitFor(() => expect(authStarts).toContain("example-server"));
    expect(installedPluginNames).toEqual([]);
    await settle();
  });

  test("an installed plugin with no servers can still be taken away", async () => {
    seededCatalog = [catalogMatch()];
    seededPlugins = [installedPlugin()];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    // Nothing was ever signed in to, but there is also no single server for a
    // tile to offer, so the integration stays where the only thing left to do
    // with it lives.
    await screen.findByRole("heading", { name: /Your integrations/ });
    fireEvent.click(screen.getByRole("button", { name: "Configure Example" }));
    await screen.findByText("Manage how Vellum connects to Example.");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Example MCP server" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(removedPluginNames).toEqual(["example-mcp"]));
    await settle();
  });

  test("keeps a multi-server plugin manageable before any sign-in", async () => {
    seededCatalog = [catalogMatch()];
    seededPlugins = [installedPlugin()];
    seededServers = [
      server({
        id: "example-a",
        source: "plugin",
        pluginName: "example-mcp",
        status: "needs-auth",
      }),
      server({
        id: "example-b",
        source: "plugin",
        pluginName: "example-mcp",
        status: "needs-auth",
      }),
    ];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    // Two servers and no credentials: a tile could not choose between them,
    // so the dialog keeps the per-server sign-ins reachable.
    await screen.findByRole("heading", { name: /Your integrations/ });
    fireEvent.click(screen.getByRole("button", { name: "Configure Example" }));
    expect(
      await screen.findAllByRole("button", { name: "Reconnect" }),
    ).toHaveLength(2);
    await settle();
  });

  test("removing a plugin stops a sign-in waiting on its sibling", async () => {
    seededCatalog = [catalogMatch()];
    seededPlugins = [installedPlugin()];
    seededServers = [
      server({
        id: "example-a",
        source: "plugin",
        pluginName: "example-mcp",
        status: "needs-auth",
      }),
      server({
        id: "example-b",
        source: "plugin",
        pluginName: "example-mcp",
        status: "needs-auth",
      }),
    ];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByRole("heading", { name: /Your integrations/ });
    fireEvent.click(screen.getByRole("button", { name: "Configure Example" }));
    // Sign in to one server, then take the plugin away from the other row.
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Reconnect" }))[0]!,
    );
    await waitFor(() => expect(authStarts).toEqual(["example-a"]));
    await screen.findByText(
      "Finish signing in to Example in your browser, then come back here.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove example-b" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(removedPluginNames).toEqual(["example-mcp"]));
    // The uninstall took example-a too, so nothing is left waiting on it.
    await waitFor(() =>
      expect(
        screen.queryByText(
          "Finish signing in to Example in your browser, then come back here.",
        ),
      ).toBeNull(),
    );
    await settle();
  });

  test("a configured row cannot start a second attempt over a live one", async () => {
    seededProviders = [provider()];
    seededConnections = [connection()];
    seededCatalog = [
      catalogMatch({
        name: "gamma-mcp",
        integration: {
          ...catalogMatch().integration!,
          displayName: "Gamma",
          logo: "gamma.png",
        },
      }),
    ];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByText("Gamma");
    fireEvent.click(screen.getByRole("button", { name: "Connect Gamma" }));
    await screen.findByText("Finish signing in to Gamma in your browser.");

    // Notion is connected and draws as a row, which was the one entry point
    // that did not honour the page's one-attempt-at-a-time rule.
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Configure Notion",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    await settle();
  });

  test("closing the dialog gives up the sign-in it was reporting", async () => {
    seededProviders = [provider()];
    seededConnections = [connection({ status: "ERROR", connected: false })];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByRole("heading", { name: /Your integrations/ });
    fireEvent.click(screen.getByRole("button", { name: "Configure Notion" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(managedConnect).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Nothing is left holding the other integrations against a wait that has
    // no surface to report it.
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Add custom integration",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    screen.getByRole("heading", { name: /Your integrations/ });
    expect(screen.queryByRole("heading", { name: /Available/ })).toBeNull();
    await settle();
  });

  test("tools and details lists what an MCP server brings", async () => {
    seededCatalog = [catalogMatch()];
    seededPlugins = [installedPlugin()];
    seededServers = [
      server({
        id: "example-server",
        source: "plugin",
        pluginName: "example-mcp",
      }),
    ];
    seededTools = [
      {
        serverId: "example-server",
        toolCount: 1,
        estimatedTokens: 1840,
        tools: [
          {
            name: "search_pages",
            description: "Full-text search across the workspace.",
            estimatedTokens: 1840,
          },
        ],
      },
    ];
    render(<IntegrationsPage />, { wrapper: Wrapper });

    await screen.findByRole("heading", { name: /Your integrations/ });
    fireEvent.click(screen.getByRole("button", { name: "Configure Example" }));
    await screen.findByText("Manage how Vellum connects to Example.");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Tools and details for Example MCP server",
      }),
    );

    await screen.findByRole("button", { name: "search_pages" });
    screen.getByText("https://mcp.example.com/mcp");
    await settle();
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
      (
        screen.getByRole("button", {
          name: "Add custom integration",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
