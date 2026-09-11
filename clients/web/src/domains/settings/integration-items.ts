import { isChannelUserIntegration } from "@vellumai/service-contracts/channels";

import type { OAuthConnection } from "@/generated/api/types.gen";
import type { OauthProvidersGetResponse } from "@/generated/daemon/types.gen";

import type { McpServerEntry } from "./mcp/mcp-api";
import type { McpCatalogEntry } from "./mcp/mcp-catalog-api";

export type IntegrationFilter = "all" | "connected" | "available";
export type OAuthProvider = OauthProvidersGetResponse["providers"][number];

export interface CatalogMethod {
  definition: McpCatalogEntry;
  servers: McpServerEntry[];
}

export type IntegrationItem = {
  id: string;
  name: string;
  description: string;
  connected: boolean;
  configured: boolean;
} & (
  | {
      kind: "oauth";
      provider: OAuthProvider;
      connections: OAuthConnection[];
      methods: CatalogMethod[];
    }
  | { kind: "catalog"; method: CatalogMethod }
  | { kind: "mcp"; server: McpServerEntry }
);

export function catalogDefinitionKey(
  entry: Pick<McpCatalogEntry, "id" | "serverKey">,
): string {
  return JSON.stringify([entry.id, entry.serverKey]);
}

export function catalogMethodServers(
  methods: CatalogMethod[],
): McpServerEntry[] {
  return methods.flatMap((method) => method.servers);
}

export function mcpDisplayName(
  server: McpServerEntry,
  definitions: McpCatalogEntry[] = [],
): string {
  const provenance = server.catalog;
  if (!provenance || server.source === "plugin") {
    return server.id;
  }
  return (
    definitions.find(
      (definition) =>
        catalogDefinitionKey(definition) === catalogDefinitionKey(provenance),
    )?.displayName ?? provenance.id
  );
}

export function summarizeIntegrationConnections(
  connections: OAuthConnection[],
  servers: McpServerEntry[] = [],
) {
  return {
    connectedCount:
      connections.filter((connection) => connection.connected).length +
      servers.filter((server) => mcpLifecycleState(server) === "connected")
        .length,
    needsAttention:
      connections.some((connection) => !connection.connected) ||
      servers.some((server) => mcpLifecycleState(server) !== "connected"),
    configured: connections.length > 0 || servers.length > 0,
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
  definitions: McpCatalogEntry[] = [],
): IntegrationItem[] {
  const methods = definitions.map(
    (definition): CatalogMethod => ({
      definition,
      servers: servers.filter(
        (server) =>
          server.source !== "plugin" &&
          server.catalog &&
          catalogDefinitionKey(server.catalog) ===
            catalogDefinitionKey(definition),
      ),
    }),
  );
  const groupedMethods = new Set<CatalogMethod>();
  const matchedServers = new Set(catalogMethodServers(methods));
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
      const alternatives = methods.filter(
        (method) => method.definition.oauthProvider === provider.provider_key,
      );
      alternatives.forEach((method) => groupedMethods.add(method));
      const mcp = catalogMethodServers(alternatives);
      return [
        {
          kind: "oauth" as const,
          id: `oauth:${provider.provider_key}`,
          name: provider.display_name ?? provider.provider_key,
          description: [
            provider.description,
            ...alternatives.map((method) => method.definition.description),
          ]
            .filter(Boolean)
            .join(" "),
          connected:
            summarizeIntegrationConnections(accounts, mcp).connectedCount > 0,
          configured: accounts.length > 0 || mcp.length > 0,
          provider,
          connections: accounts,
          methods: alternatives,
        },
      ];
    });
  return [
    ...oauth,
    ...methods
      .filter((method) => !groupedMethods.has(method))
      .map(
        (method): IntegrationItem => ({
          kind: "catalog",
          id: `catalog:${catalogDefinitionKey(method.definition)}`,
          name: method.definition.displayName,
          description: method.definition.description,
          connected:
            summarizeIntegrationConnections([], method.servers).connectedCount >
            0,
          configured: method.servers.length > 0,
          method,
        }),
      ),
    ...servers
      .filter((server) => !matchedServers.has(server))
      .map(
        (server): IntegrationItem => ({
          kind: "mcp",
          id: `mcp:${server.id}`,
          name: mcpDisplayName(server, definitions),
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
