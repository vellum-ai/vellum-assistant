import type { OAuthConnection } from "@/generated/api/types.gen";

import type { OAuthProvider } from "./integration-items";
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
