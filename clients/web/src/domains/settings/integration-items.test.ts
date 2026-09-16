import { describe, expect, test } from "bun:test";

import type { OAuthConnection } from "@/generated/api/types.gen";

import {
  buildIntegrationItems,
  connectionsForOAuthProvider,
  filterIntegrationItems,
  type OAuthProvider,
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
