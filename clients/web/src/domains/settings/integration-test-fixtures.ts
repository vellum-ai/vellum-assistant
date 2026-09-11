import type { OAuthConnection } from "@/generated/api/types.gen";

import type { OAuthProvider } from "./integration-items";
import type { McpCatalogEntry } from "./mcp/mcp-catalog-api";
import type { McpServerEntry } from "./mcp/mcp-api";

export function oauthConnection(
  overrides: Partial<OAuthConnection> = {},
): OAuthConnection {
  return {
    id: "connection-1",
    provider: "notion",
    status: "ACTIVE",
    connected: true,
    account_label: "Example workspace",
    scopes_granted: [],
    expires_at: null,
    ...overrides,
  };
}

export function oauthProvider(
  overrides: Partial<OAuthProvider> = {},
): OAuthProvider {
  return {
    provider_key: "notion",
    display_name: "Notion",
    description: null,
    dashboard_url: null,
    client_id_placeholder: null,
    requires_client_secret: false,
    logo_url: null,
    supports_managed_mode: true,
    managed_service_is_paid: false,
    feature_flag: null,
    acts_as: "user",
    ...overrides,
  };
}

export function mcpServer(
  overrides: Partial<McpServerEntry> = {},
): McpServerEntry {
  return {
    id: "example-integration",
    status: "connected",
    transport: { type: "streamable-http", url: "https://example.com/mcp" },
    hasOAuth: false,
    hasStaticAuth: false,
    authType: "none",
    ...overrides,
  };
}

export function mcpCatalogEntry(
  overrides: Partial<McpCatalogEntry> = {},
): McpCatalogEntry {
  return {
    id: "fathom",
    serverKey: "fathom",
    definitionDigest: "a".repeat(64),
    displayName: "Fathom",
    description: "Search meeting notes and summaries.",
    documentationUrl: "https://example.com/setup",
    verifiedAt: "2026-09-10",
    verification: "documentation-only",
    setup: { mode: "oauth" },
    icon: "fathom",
    documents: {
      plugin: { name: "fathom" },
      mcp: {
        mcpServers: {
          fathom: { type: "streamable-http", url: "https://example.com/mcp" },
        },
      },
    },
    ...overrides,
  };
}
