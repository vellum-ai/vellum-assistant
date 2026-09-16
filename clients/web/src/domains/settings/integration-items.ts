import { isChannelUserIntegration } from "@vellumai/service-contracts/channels";

import type { OAuthConnection } from "@/generated/api/types.gen";
import type { OauthProvidersGetResponse } from "@/generated/daemon/types.gen";

import type { McpServerEntry } from "./mcp/mcp-api";

export type OAuthProvider = OauthProvidersGetResponse["providers"][number];

export type IntegrationItem = {
  id: string;
  name: string;
  description: string;
  configured: boolean;
} & (
  | {
      kind: "oauth";
      provider: OAuthProvider;
      connections: OAuthConnection[];
    }
  | { kind: "mcp"; server: McpServerEntry }
);

export function summarizeOAuthConnections(connections: OAuthConnection[]) {
  return {
    connectedCount: connections.filter((connection) => connection.connected)
      .length,
    needsAttention: connections.some((connection) => !connection.connected),
  };
}

export function connectionsForOAuthProvider(
  connections: OAuthConnection[],
  providerKey: string,
): OAuthConnection[] {
  return connections.filter(
    (connection) => connection.provider === providerKey,
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
      const accounts = connectionsForOAuthProvider(
        connections,
        provider.provider_key,
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
        description: [server.pluginName, integrationHostname(server)]
          .filter(Boolean)
          .join(" "),
        configured: true,
        server,
      }),
    ),
  ];
}

export function filterIntegrationItems(
  items: IntegrationItem[],
  searchText: string,
): IntegrationItem[] {
  const needle = searchText.trim().toLocaleLowerCase();
  return items
    .filter(
      (item) =>
        !needle ||
        item.name.toLocaleLowerCase().includes(needle) ||
        item.description.toLocaleLowerCase().includes(needle),
    )
    .sort(
      (a, b) =>
        Number(b.configured) - Number(a.configured) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}
