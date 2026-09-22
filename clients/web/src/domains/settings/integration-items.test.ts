import { describe, expect, test } from "bun:test";

import type { OAuthConnection } from "@/generated/api/types.gen";

import {
  buildIntegrationItems,
  connectionsForOAuthProvider,
  filterIntegrationItems,
  isMcpPluginMethodConfigured,
  type McpPluginDefinition,
  type OAuthProvider,
  summarizeIntegrationConnections,
  summarizeOAuthConnections,
} from "./integration-items";
import type { McpServerEntry } from "./mcp/mcp-api";

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
    id: "example-server",
    status: "connected",
    transport: {
      type: "streamable-http",
      url: "https://mcp.example.com/path",
    },
    hasOAuth: false,
    hasStaticAuth: false,
    authType: "none",
    ...overrides,
  };
}

function plugin(
  overrides: Partial<McpPluginDefinition> = {},
): McpPluginDefinition {
  return {
    pluginName: "notion-mcp",
    displayName: "Notion",
    description: "Search and update Notion",
    documentationUrl: "https://example.com/docs/notion",
    logo: "notion.png",
    oauthProvider: "notion",
    setup: { mode: "oauth", instructions: "Sign in to Notion." },
    ...overrides,
  };
}

describe("integration items", () => {
  test("provider state is connected when any exact account is active", () => {
    expect(
      summarizeOAuthConnections([
        connection(),
        connection({
          id: "connection-2",
          status: "ERROR",
          connected: false,
        }),
      ]),
    ).toEqual({ connectedCount: 1, needsAttention: true });
  });

  test("combines provider accounts with exact plugin-owned MCP servers", () => {
    const method = {
      definition: plugin({ installed: {} }),
      servers: [
        server({
          source: "plugin",
          pluginName: "notion-mcp",
          status: "needs-auth",
          hasOAuth: true,
        }),
      ],
    };

    expect(summarizeIntegrationConnections([connection()], [method])).toEqual({
      connectedCount: 1,
      needsAttention: true,
      configured: true,
    });
  });

  test("leaves a plugin nobody ever signed in to out of the connected list", () => {
    // One remote server and no credentials: what a cancelled sign-in leaves,
    // and the one state a tile can finish by itself.
    const method = {
      definition: plugin({ installed: {} }),
      servers: [
        server({
          source: "plugin",
          pluginName: "notion-mcp",
          status: "needs-auth",
        }),
      ],
    };

    // A cancelled sign-in leaves exactly this: the plugin installed, its
    // server declared, nothing authorized. It is still on offer, and there is
    // nothing for the user to attend to.
    expect(summarizeIntegrationConnections([], [method])).toEqual({
      connectedCount: 0,
      needsAttention: false,
      configured: false,
    });
    expect(isMcpPluginMethodConfigured(method)).toBe(false);
  });

  test("counts a plugin with stored credentials as configured", () => {
    const declared = server({
      source: "plugin",
      pluginName: "notion-mcp",
      status: "declared",
      hasOAuth: true,
    });
    expect(
      isMcpPluginMethodConfigured({
        definition: plugin({ installed: {} }),
        servers: [declared],
      }),
    ).toBe(true);
    expect(
      isMcpPluginMethodConfigured({
        definition: plugin({ installed: {} }),
        servers: [
          server({
            source: "plugin",
            pluginName: "notion-mcp",
            status: "needs-auth",
            hasStaticAuth: true,
          }),
        ],
      }),
    ).toBe(true);
  });

  test("trusts the install while the server list is unknown", () => {
    const method = {
      definition: plugin({ installed: {} }),
      servers: [],
    };
    // A server list that failed to load is the same empty array as a plugin
    // whose servers are all unauthorized. Until the real answer arrives, a
    // connected integration stays where the user last saw it, with nothing
    // asking to be attended to.
    expect(isMcpPluginMethodConfigured(method, false)).toBe(true);
    expect(summarizeIntegrationConnections([], [method], false)).toEqual({
      connectedCount: 0,
      needsAttention: false,
      configured: true,
    });
    expect(
      buildIntegrationItems(
        [],
        [],
        [],
        [plugin({ oauthProvider: undefined, installed: {} })],
        false,
      ),
    ).toMatchObject([{ id: "plugin:notion-mcp", configured: true }]);
  });

  test("keeps what a tile cannot finish out of the available list", () => {
    const definition = plugin({ installed: {} });
    // Nothing is authorized in any of these, and none of them has a single
    // remote server a tile could sign in to, so each one keeps the dialog
    // that can deal with it.
    expect(isMcpPluginMethodConfigured({ definition, servers: [] })).toBe(true);
    expect(
      isMcpPluginMethodConfigured({
        definition,
        servers: [
          server({
            id: "a",
            source: "plugin",
            pluginName: "notion-mcp",
            status: "needs-auth",
          }),
          server({
            id: "b",
            source: "plugin",
            pluginName: "notion-mcp",
            status: "needs-auth",
          }),
        ],
      }),
    ).toBe(true);
    expect(
      isMcpPluginMethodConfigured({
        definition,
        servers: [
          server({
            source: "plugin",
            pluginName: "notion-mcp",
            status: "declared",
            transport: { type: "stdio", command: "notion-mcp" },
          }),
        ],
      }),
    ).toBe(true);
  });

  test("keeps active and inactive exact accounts for one provider", () => {
    const inactive = connection({
      id: "connection-2",
      status: "ERROR",
      connected: false,
    });
    expect(
      connectionsForOAuthProvider(
        [connection(), inactive, connection({ provider: "github" })],
        "notion",
      ),
    ).toEqual([connection(), inactive]);
    expect(connectionsForOAuthProvider([inactive], "notion")).toEqual([
      inactive,
    ]);
  });

  test("keeps saved OAuth accounts and every MCP server configured", () => {
    const items = buildIntegrationItems(
      [provider()],
      [connection({ status: "ERROR", connected: false })],
      [server({ status: "error" })],
    );

    expect(items.map(({ id, configured }) => [id, configured])).toEqual([
      ["oauth:notion", true],
      ["mcp:example-server", true],
    ]);
  });

  test("groups an installed plugin with its explicitly mapped OAuth provider", () => {
    const items = buildIntegrationItems(
      [provider()],
      [],
      [
        server({
          id: "notion-tools",
          source: "plugin",
          pluginName: "notion-mcp",
        }),
      ],
      [plugin({ installed: { hasIcon: true, iconVersion: "v1" } })],
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "oauth",
      id: "oauth:notion",
      configured: true,
      methods: [
        {
          definition: { pluginName: "notion-mcp" },
          servers: [{ id: "notion-tools" }],
        },
      ],
    });
  });

  test("keeps a connected provider configured after its plugin is removed", () => {
    const items = buildIntegrationItems(
      [provider()],
      [connection()],
      [],
      [plugin({ installed: undefined })],
    );

    expect(items).toMatchObject([
      {
        kind: "oauth",
        id: "oauth:notion",
        configured: true,
        connections: [{ connected: true }],
        methods: [{ servers: [] }],
      },
    ]);
  });

  test("keeps same-brand workspace servers separate from plugin ownership", () => {
    const items = buildIntegrationItems(
      [provider()],
      [],
      [
        server({ id: "notion-workspace", source: "workspace" }),
        server({
          id: "notion-plugin",
          source: "plugin",
          pluginName: "notion-mcp",
        }),
      ],
      [plugin({ installed: {} })],
    );

    expect(items.map((item) => item.id)).toEqual([
      "oauth:notion",
      "mcp:notion-workspace",
    ]);
  });

  test("keeps a curated plugin available until it is installed", () => {
    expect(buildIntegrationItems([], [], [], [plugin()])).toMatchObject([
      {
        kind: "plugin",
        id: "plugin:notion-mcp",
        configured: false,
      },
    ]);
  });

  test("keeps every server owned by one plugin in one configured row", () => {
    const items = buildIntegrationItems(
      [],
      [],
      [
        server({
          id: "notion-search",
          source: "plugin",
          pluginName: "notion-mcp",
        }),
        server({
          id: "notion-write",
          source: "plugin",
          pluginName: "notion-mcp",
        }),
      ],
      [plugin({ oauthProvider: undefined, installed: {} })],
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "plugin",
      configured: true,
      method: {
        servers: [{ id: "notion-search" }, { id: "notion-write" }],
      },
    });
  });

  test("withholds an unconfigured channel grant and keeps an existing one", () => {
    const discord = provider({
      provider_key: "discord",
      display_name: "Discord",
    });
    expect(buildIntegrationItems([discord], [], [])).toEqual([]);
    expect(
      buildIntegrationItems(
        [discord],
        [connection({ provider: "discord" })],
        [],
      ).map((item) => item.id),
    ).toEqual(["oauth:discord"]);
  });

  test("searches OAuth descriptions and MCP endpoint hosts", () => {
    const items = buildIntegrationItems([provider()], [], [server()]);
    expect(filterIntegrationItems(items, "workspace").map((item) => item.id)).toEqual([
      "oauth:notion",
    ]);
    expect(filterIntegrationItems(items, "mcp.example").map((item) => item.id)).toEqual([
      "mcp:example-server",
    ]);
  });

  test("narrows to one category when a chip is chosen", () => {
    const items = buildIntegrationItems(
      [provider(), provider({ provider_key: "hubspot", category: "sales" })],
      [],
      [server()],
    );

    expect(
      filterIntegrationItems(items, "", "sales").map((item) => item.id),
    ).toEqual(["oauth:hubspot"]);
    // A custom server has no category, so only the unfiltered list has it.
    expect(
      filterIntegrationItems(items, "", "productivity").map((item) => item.id),
    ).toEqual(["oauth:notion"]);
    expect(filterIntegrationItems(items, "", null).map((item) => item.id)).toEqual([
      "mcp:example-server",
      "oauth:hubspot",
      "oauth:notion",
    ]);
  });

  test("files an integration under no category when its slug is unknown here", () => {
    const [item] = buildIntegrationItems(
      [provider({ category: "future" as never })],
      [],
      [],
    );

    expect(item.category).toBeNull();
  });

  test("searches the visible plugin name when its server also has a URL", () => {
    const items = buildIntegrationItems(
      [],
      [],
      [
        server({
          source: "plugin",
          pluginName: "Team knowledge",
          transport: {
            type: "streamable-http",
            url: "https://mcp.example.com/path",
          },
        }),
      ],
    );

    expect(
      filterIntegrationItems(items, "team knowledge").map((item) => item.id),
    ).toEqual(["mcp:example-server"]);
  });
});
