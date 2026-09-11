import { isChannelUserIntegration } from "@vellumai/service-contracts/channels";

import type { OAuthConnection } from "@/generated/api/types.gen";
import type { OauthProvidersGetResponse } from "@/generated/daemon/types.gen";

import type { McpServerEntry } from "./mcp/mcp-api";

export type IntegrationFilter = "all" | "connected" | "available";
export type OAuthProvider = OauthProvidersGetResponse["providers"][number];

type IntegrationItem = {
  id: string;
  name: string;
  description: string;
  connected: boolean;
  configured: boolean;
} & (
  | { kind: "oauth"; provider: OAuthProvider; connections: OAuthConnection[] }
  | { kind: "mcp"; server: McpServerEntry }
);

export function summarizeOAuthConnections(connections: OAuthConnection[]) {
  return {
    connectedCount: connections.filter((connection) => connection.connected)
      .length,
    needsAttention: connections.some((connection) => !connection.connected),
  };
}

export function mcpLifecycleState(server: McpServerEntry) {
  return server.lifecycleState ?? server.status;
}

export function supportsMcpAction(
  server: McpServerEntry,
  action: NonNullable<McpServerEntry["supportedActions"]>[number],
): boolean {
  if (server.source === "plugin") {
    return action === "manage-plugin";
  }
  if (server.supportedActions) {
    return server.supportedActions.includes(action);
  }
  return (
    action !== "manage-plugin" &&
    (action !== "authenticate" || server.transport.type !== "stdio")
  );
}

export function integrationHostname(
  server: McpServerEntry,
): string | undefined {
  if (!server.transport.url) {
    return undefined;
  }
  try {
    return new URL(server.transport.url).hostname;
  } catch {
    return undefined;
  }
}

export function buildIntegrationItems(
  providers: OAuthProvider[],
  connections: OAuthConnection[],
  servers: McpServerEntry[],
): IntegrationItem[] {
  const oauth: IntegrationItem[] = providers
    .filter((provider) => provider.supports_managed_mode)
    .flatMap((provider) => {
      const accounts = connections.filter(
        (connection) => connection.provider === provider.provider_key,
      );
      if (
        isChannelUserIntegration(provider.provider_key) &&
        accounts.length === 0
      ) {
        return [];
      }
      return [
        {
          kind: "oauth" as const,
          id: `oauth:${provider.provider_key}`,
          name: provider.display_name ?? provider.provider_key,
          description: provider.description ?? "",
          connected: summarizeOAuthConnections(accounts).connectedCount > 0,
          configured: accounts.length > 0,
          provider,
          connections: accounts,
        },
      ];
    });
  return [
    ...oauth,
    ...servers.map(
      (server): IntegrationItem => ({
        kind: "mcp",
        id: `mcp:${server.id}`,
        name: server.id,
        description: integrationHostname(server) ?? server.pluginName ?? "",
        connected: mcpLifecycleState(server) === "connected",
        configured: true,
        server,
      }),
    ),
  ];
}

export function filterIntegrationItems(
  items: IntegrationItem[],
  searchText: string,
  filter: IntegrationFilter,
): IntegrationItem[] {
  const needle = searchText.trim().toLocaleLowerCase();
  return items
    .filter((item) => {
      if (filter === "connected" && !item.connected) {
        return false;
      }
      if (filter === "available" && item.connected) {
        return false;
      }
      return (
        !needle ||
        item.name.toLocaleLowerCase().includes(needle) ||
        item.description.toLocaleLowerCase().includes(needle)
      );
    })
    .sort(
      (a, b) =>
        Number(b.configured) - Number(a.configured) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}
