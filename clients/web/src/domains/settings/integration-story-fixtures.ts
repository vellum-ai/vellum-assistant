import type { OAuthConnection } from "@/generated/api/types.gen";
import type { PlatformGateState } from "@/hooks/use-platform-gate";

import {
  buildConnectPlan,
  type ConnectPlan,
  type ConnectableIntegrationItem,
} from "./connect-plan";
import {
  buildIntegrationItems,
  type McpPluginDefinition,
  type OAuthProvider,
} from "./integration-items";
import type { McpServerEntry } from "./mcp/mcp-api";

/**
 * Catalog shapes for the Integrations stories.
 *
 * The connect modal and the integration tile are two surfaces onto the same
 * plan, so they read the same fixtures: a provider that only differed between
 * them would let one story document a catalog the other can never receive.
 */

export function oauthProvider(
  providerKey: OAuthConnection["provider"],
  displayName: string,
  description: string,
): OAuthProvider {
  return {
    provider_key: providerKey,
    display_name: displayName,
    description,
    dashboard_url: `https://developers.example.com/${providerKey}`,
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

export function oauthConnection(
  providerKey: OAuthConnection["provider"],
  overrides: Partial<OAuthConnection> = {},
): OAuthConnection {
  return {
    id: `conn-${providerKey}`,
    provider: providerKey,
    status: "ACTIVE",
    connected: true,
    account_label: "user@example.com",
    scopes_granted: [],
    expires_at: null,
    ...overrides,
  };
}

export function pluginDefinition(
  overrides: Partial<McpPluginDefinition> = {},
): McpPluginDefinition {
  return {
    pluginName: "notion-mcp",
    displayName: "Notion MCP",
    description: "Search and edit Notion pages through Notion's own server.",
    documentationUrl: "https://example.com/docs/notion-mcp",
    logo: "",
    oauthProvider: "notion",
    setup: {
      mode: "oauth",
      instructions: "Sign in with the workspace you want Vellum to use.",
    },
    ...overrides,
  };
}

export function mcpServer(
  pluginName: string,
  overrides: Partial<McpServerEntry> = {},
): McpServerEntry {
  return {
    id: `${pluginName}-server`,
    status: "connected",
    source: "plugin",
    pluginName,
    transport: {
      type: "streamable-http",
      url: `https://mcp.example.com/${pluginName}`,
    },
    hasOAuth: true,
    hasStaticAuth: false,
    authType: "none",
    ...overrides,
  };
}

/**
 * Derive the plan the way the Integrations page does: group the catalog into
 * items, then collapse the one item under review into its connect plan. A
 * story that hand-wrote a `ConnectPlan` would document a shape the list can
 * never produce.
 */
export function planFor({
  providers = [],
  connections = [],
  servers = [],
  definitions = [],
  platformGate = "full",
  ownOAuthAvailable = false,
  mcpServersLoaded = true,
}: {
  providers?: OAuthProvider[];
  connections?: OAuthConnection[];
  servers?: McpServerEntry[];
  definitions?: McpPluginDefinition[];
  platformGate?: PlatformGateState;
  ownOAuthAvailable?: boolean;
  /** A fixture has its servers in hand, so the list counts as read. */
  mcpServersLoaded?: boolean;
}): ConnectPlan {
  const items = buildIntegrationItems(
    providers,
    connections,
    servers,
    definitions,
  );
  const item = items.find(
    (candidate): candidate is ConnectableIntegrationItem =>
      candidate.kind !== "mcp",
  );
  const plan = item
    ? buildConnectPlan(item, {
        platformGate,
        ownOAuthAvailable,
        mcpServersLoaded,
      })
    : null;
  if (!plan) {
    throw new Error("No connectable integration in the fixture");
  }
  return plan;
}

export const NOTION_PROVIDER = oauthProvider(
  "notion",
  "Notion",
  "Read and write pages in your Notion workspace.",
);
export const GOOGLE_PROVIDER = oauthProvider(
  "google",
  "Google",
  "Mail, Calendar, and Drive from your Google account.",
);
export const LINEAR_PROVIDER = oauthProvider(
  "linear",
  "Linear",
  "Track issues and projects in Linear.",
);
export const FIGMA_PROVIDER = oauthProvider(
  "figma",
  "Figma",
  "Read files and comments from your Figma projects.",
);
export const ASANA_PROVIDER = oauthProvider(
  "asana",
  "Asana",
  "Tasks and projects from your Asana workspace.",
);
export const GITHUB_PROVIDER = oauthProvider(
  "github",
  "GitHub",
  "Issues, pull requests, and code search on GitHub.",
);

/** Platform-hosted Notion: the MCP server leads, Vellum's OAuth is behind it. */
export const notionPlan = planFor({
  providers: [NOTION_PROVIDER],
  definitions: [pluginDefinition()],
});

/** Managed OAuth and nothing else, so the connect action has no chevron. */
export const googlePlan = planFor({ providers: [GOOGLE_PROVIDER] });

/**
 * Linear's own MCP server with Vellum's hosted sign-in behind it: the shape a
 * failed attempt needs, since there is somewhere else to send the user.
 */
export const linearMcpPlan = planFor({
  providers: [LINEAR_PROVIDER],
  definitions: [
    pluginDefinition({
      pluginName: "linear-mcp",
      displayName: "Linear MCP",
      description: "Issues, projects, and documents from Linear's own server.",
      documentationUrl: "https://example.com/docs/linear-mcp",
      oauthProvider: "linear",
      setup: {
        mode: "oauth",
        instructions:
          "Sign in with the account you want Vellum to use. A workspace admin must enable MCP.",
      },
    }),
  ],
});

/**
 * A server whose provider states its own conditions: an admin has to enable
 * MCP, and free plans are not served at all.
 */
export const ashbyPlan = planFor({
  definitions: [
    pluginDefinition({
      pluginName: "ashby-mcp",
      displayName: "Ashby",
      description: "Search candidates and jobs in Ashby.",
      oauthProvider: undefined,
      setup: {
        mode: "oauth",
        instructions:
          "Sign in with the account you want Vellum to use. An organization admin must enable MCP. The server is unavailable on free plans.",
      },
    }),
  ],
});
