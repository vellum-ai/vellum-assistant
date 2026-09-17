import { isChannelUserIntegration } from "@vellumai/service-contracts/channels";

import type { OAuthConnection } from "@/generated/api/types.gen";
import type { OauthProvidersGetResponse } from "@/generated/daemon/types.gen";

import type { McpServerEntry } from "./mcp/mcp-api";

export type OAuthProvider = OauthProvidersGetResponse["providers"][number];

export interface McpPluginDefinition {
  pluginName: string;
  displayName: string;
  description: string;
  documentationUrl: string;
  logo: string;
  oauthProvider?: string;
  setup: {
    mode: "oauth" | "manual";
    instructions: string;
  };
  installed?: {
    icon?: string;
    hasIcon?: boolean;
    iconVersion?: string;
  };
}

export interface McpPluginMethod {
  definition: McpPluginDefinition;
  servers: McpServerEntry[];
}

export function mcpServersForPlugin(
  servers: readonly McpServerEntry[],
  pluginName: string,
): McpServerEntry[] {
  return servers.filter(
    (server) => server.source === "plugin" && server.pluginName === pluginName,
  );
}

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
      methods: McpPluginMethod[];
    }
  | { kind: "plugin"; method: McpPluginMethod }
  | { kind: "mcp"; server: McpServerEntry }
);

export function summarizeOAuthConnections(connections: OAuthConnection[]) {
  const { connectedCount, needsAttention } = summarizeIntegrationConnections(
    connections,
    [],
  );
  return {
    connectedCount,
    needsAttention,
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

export function summarizeIntegrationConnections(
  connections: OAuthConnection[],
  methods: McpPluginMethod[],
) {
  const servers = methods.flatMap((method) => method.servers);
  const configuredMethods = methods.filter(isMcpPluginMethodConfigured);
  return {
    connectedCount:
      connections.filter((connection) => connection.connected).length +
      servers.filter((server) => server.status === "connected").length,
    needsAttention:
      connections.some((connection) => !connection.connected) ||
      configuredMethods.some(
        (method) =>
          method.servers.length === 0 ||
          method.servers.some((server) => server.status !== "connected"),
      ),
    configured: connections.length > 0 || configuredMethods.length > 0,
  };
}

export function isMcpPluginMethodConfigured(method: McpPluginMethod): boolean {
  return Boolean(method.definition.installed || method.servers.length > 0);
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
  definitions: McpPluginDefinition[] = [],
): IntegrationItem[] {
  const methods = definitions.map(
    (definition): McpPluginMethod => ({
      definition,
      servers: mcpServersForPlugin(servers, definition.pluginName),
    }),
  );
  const groupedMethods = new Set<McpPluginMethod>();
  const matchedServers = new Set(methods.flatMap((method) => method.servers));
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
      const alternatives = methods.filter(
        (method) => method.definition.oauthProvider === provider.provider_key,
      );
      alternatives.forEach((method) => groupedMethods.add(method));
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
          configured: summarizeIntegrationConnections(accounts, alternatives)
            .configured,
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
          kind: "plugin",
          id: `plugin:${method.definition.pluginName}`,
          name: method.definition.displayName,
          description: method.definition.description,
          configured: Boolean(
            method.definition.installed || method.servers.length > 0,
          ),
          method,
        }),
      ),
    ...servers
      .filter((server) => !matchedServers.has(server))
      .map(
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
