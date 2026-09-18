import { describe, expect, test } from "bun:test";

import type { OAuthConnection } from "@/generated/api/types.gen";

import {
  buildConnectPlan,
  connectableMethods,
  planMethods,
  type ConnectPlan,
  type ConnectPlanContext,
  type ConnectableIntegrationItem,
} from "./connect-plan";
import type {
  McpPluginDefinition,
  McpPluginMethod,
  OAuthProvider,
} from "./integration-items";
import type { McpServerEntry } from "./mcp/mcp-api";

function provider(): OAuthProvider {
  return {
    provider_key: "notion",
    display_name: "Notion",
    description: "Read and write Notion pages.",
    dashboard_url: "https://www.notion.so/my-integrations",
    client_id_placeholder: null,
    requires_client_secret: true,
    logo_url: null,
    supports_managed_mode: true,
    managed_service_is_paid: false,
    feature_flag: null,
    tenant_host: null,
    acts_as: "user",
  };
}

function connection(): OAuthConnection {
  return {
    id: "conn-1",
    provider: "notion",
    status: "ACTIVE",
    connected: true,
    account_label: "user@example.com",
    scopes_granted: [],
    expires_at: null,
  };
}

function definition(
  overrides: Partial<McpPluginDefinition> = {},
): McpPluginDefinition {
  return {
    pluginName: "notion-mcp",
    displayName: "Notion MCP",
    description: "The Notion MCP server.",
    documentationUrl: "https://example.com/docs/notion",
    logo: "",
    oauthProvider: "notion",
    setup: { mode: "oauth", instructions: "Sign in with your workspace." },
    ...overrides,
  };
}

function pluginMethod(
  overrides: Partial<McpPluginDefinition> = {},
): McpPluginMethod {
  return { definition: definition(overrides), servers: [] };
}

function connectedServer(): McpServerEntry {
  return {
    id: "notion",
    status: "connected",
    source: "plugin",
    pluginName: "notion-mcp",
    transport: {
      type: "streamable-http",
      url: "https://mcp.example.com/notion-mcp",
    },
    hasOAuth: true,
    hasStaticAuth: false,
    authType: "none",
  };
}

function oauthItem(methods: McpPluginMethod[]): ConnectableIntegrationItem {
  return {
    kind: "oauth",
    id: "oauth:notion",
    name: "Notion",
    description: "Read and write Notion pages.",
    configured: false,
    provider: provider(),
    connections: [connection()],
    methods,
  };
}

/** Every case but the gated one expects a plan, so assert it once here. */
function planOf(
  item: ConnectableIntegrationItem,
  context: ConnectPlanContext,
): ConnectPlan {
  const plan = buildConnectPlan(item, context);
  if (!plan) {
    throw new Error("expected a connect plan");
  }
  return plan;
}

describe("buildConnectPlan", () => {
  test("puts the provider's MCP server ahead of managed OAuth", () => {
    const plan = planOf(oauthItem([pluginMethod()]), {
      platformGate: "full",
      ownOAuthAvailable: false,
      mcpServersLoaded: true,
    });

    expect(plan.primary.kind).toBe("mcp-oauth");
    expect(plan.alternatives.map((method) => method.kind)).toEqual([
      "managed-oauth",
    ]);
  });

  test("leads with managed OAuth when the catalog has no MCP server", () => {
    const plan = planOf(oauthItem([]), {
      platformGate: "full",
      ownOAuthAvailable: false,
      mcpServersLoaded: true,
    });

    expect(plan.primary.kind).toBe("managed-oauth");
    expect(plan.alternatives).toEqual([]);
  });

  test("keeps managed OAuth but marks it login-required without a session", () => {
    const plan = planOf(oauthItem([]), {
      platformGate: "disabled",
      ownOAuthAvailable: false,
      mcpServersLoaded: true,
    });

    expect(plan.primary.kind).toBe("managed-oauth");
    expect(plan.primary.availability).toBe("login-required");
  });

  test("drops managed OAuth entirely when the platform is gated", () => {
    const plan = planOf(oauthItem([pluginMethod()]), {
      platformGate: "gated",
      ownOAuthAvailable: false,
      mcpServersLoaded: true,
    });

    expect(planMethods(plan).map((method) => method.kind)).toEqual([
      "mcp-oauth",
    ]);
  });

  test("has no plan at all when the last path is dropped", () => {
    expect(
      buildConnectPlan(oauthItem([]), {
        platformGate: "gated",
        ownOAuthAvailable: false,
        mcpServersLoaded: true,
      }),
    ).toBeNull();
  });

  test("offers a bring-your-own OAuth app only where one can exist", () => {
    const context = { platformGate: "full" as const };

    expect(
      planMethods(
        planOf(oauthItem([]), {
          ...context,
          ownOAuthAvailable: false,
          mcpServersLoaded: true,
        }),
      ).map((method) => method.kind),
    ).toEqual(["managed-oauth"]);

    expect(
      planMethods(
        planOf(oauthItem([]), {
          ...context,
          ownOAuthAvailable: true,
          mcpServersLoaded: true,
        }),
      ).map((method) => method.kind),
    ).toEqual(["managed-oauth", "own-oauth"]);
  });

  test("stands an installed plugin up on its own once the servers are in", () => {
    const plan = planOf(oauthItem([pluginMethod({ installed: {} })]), {
      platformGate: "full",
      ownOAuthAvailable: false,
      mcpServersLoaded: true,
    });

    expect(plan.primary.connections.map((row) => row.pluginName)).toEqual([
      "notion-mcp",
    ]);
  });

  test("waits for the server list before calling a plugin server-less", () => {
    // Loading and failed both hand this an empty array. Reading either as
    // "the plugin declared nothing" puts a row on screen that offers to
    // uninstall a plugin whose servers were only unavailable.
    const plan = planOf(oauthItem([pluginMethod({ installed: {} })]), {
      platformGate: "full",
      ownOAuthAvailable: false,
      mcpServersLoaded: false,
    });

    expect(plan.primary.connections).toEqual([]);
  });

  test("reads a manual MCP setup as its own kind and keeps its instructions", () => {
    const plan = planOf(
      {
        kind: "plugin",
        id: "plugin:ramp-mcp",
        name: "Ramp",
        description: "The Ramp MCP server.",
        configured: false,
        method: pluginMethod({
          pluginName: "ramp-mcp",
          oauthProvider: undefined,
          setup: {
            mode: "manual",
            instructions: "A Ramp admin must allowlist the callback URL.",
          },
        }),
      },
      { platformGate: "full", ownOAuthAvailable: false, mcpServersLoaded: true },
    );

    expect(plan.primary.kind).toBe("mcp-manual");
    expect(plan.primary.instructions).toBe(
      "A Ramp admin must allowlist the callback URL.",
    );
  });

  test("resolves a plugin's logo to the asset it ships, not a bare file name", () => {
    // The catalog gives a file name. Handed to an `<img>` as-is it resolves
    // against the page's own path, so the tile 404s on any nested route and
    // falls back to initials.
    const plan = planOf(
      {
        kind: "plugin",
        id: "plugin:ashby-mcp",
        name: "Ashby",
        description: "The Ashby MCP server.",
        configured: false,
        method: pluginMethod({
          pluginName: "ashby-mcp",
          oauthProvider: undefined,
          logo: "ashby-mcp.png",
        }),
      },
      { platformGate: "full", ownOAuthAvailable: false, mcpServersLoaded: true },
    );

    // Matched on the substring, not the whole string: `publicAsset()` prefixes
    // `import.meta.env.BASE_URL`, which Vite supplies and the test runner does
    // not. What matters is that the catalog's bare file name became a path
    // under `public/` rather than staying relative to the page.
    expect(plan.logoUrl).toContain("images/integrations/ashby-mcp.png");
    expect(plan.logoUrl).not.toBe("ashby-mcp.png");
  });

  test("leaves a plugin that ships no logo without one", () => {
    const plan = planOf(
      {
        kind: "plugin",
        id: "plugin:ramp-mcp",
        name: "Ramp",
        description: "The Ramp MCP server.",
        configured: false,
        method: pluginMethod({ pluginName: "ramp-mcp", logo: "" }),
      },
      { platformGate: "full", ownOAuthAvailable: false, mcpServersLoaded: true },
    );

    expect(plan.logoUrl).toBeNull();
  });
});

describe("connectableMethods", () => {
  test("keeps an MCP method on offer while nothing is connected to it", () => {
    const plan = planOf(oauthItem([pluginMethod()]), {
      platformGate: "full",
      ownOAuthAvailable: false,
      mcpServersLoaded: true,
    });

    expect(connectableMethods(plan).map((method) => method.kind)).toEqual([
      "mcp-oauth",
      "managed-oauth",
    ]);
  });

  test("drops an MCP method once its server is installed", () => {
    const plan = planOf(
      oauthItem([{ definition: definition(), servers: [connectedServer()] }]),
      {
        platformGate: "full",
        ownOAuthAvailable: true,
        mcpServersLoaded: true,
      },
    );

    expect(planMethods(plan).map((method) => method.kind)).toEqual([
      "mcp-oauth",
      "managed-oauth",
      "own-oauth",
    ]);
    expect(connectableMethods(plan).map((method) => method.kind)).toEqual([
      "managed-oauth",
      "own-oauth",
    ]);
  });
});
