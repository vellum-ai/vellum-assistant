import { isChannelUserIntegration } from "@vellumai/service-contracts/channels";
import {
  type IntegrationCategory,
  isIntegrationCategory,
} from "@vellumai/service-contracts/integration-categories";

import type { OAuthConnection } from "@/generated/api/types.gen";
import type { OauthProvidersGetResponse } from "@/generated/daemon/types.gen";

import type { McpServerEntry } from "./mcp/mcp-api";
import { pluginAuthTarget } from "./mcp/plugin-mcp-connect";

export type OAuthProvider = OauthProvidersGetResponse["providers"][number];

export interface McpPluginDefinition {
  pluginName: string;
  displayName: string;
  description: string;
  documentationUrl: string;
  logo: string;
  oauthProvider?: string;
  category?: IntegrationCategory;
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
  /** Where the catalog files the integration; a custom server has no place. */
  category: IntegrationCategory | null;
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

/**
 * The category a catalog entry names, or `null` when this build does not know
 * it: a newer assistant can file an integration under a category the client
 * has no chip for, and that integration must still list.
 */
export function integrationCategory(value: unknown): IntegrationCategory | null {
  return isIntegrationCategory(value) ? value : null;
}

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
  mcpServersKnown = true,
) {
  const servers = methods.flatMap((method) => method.servers);
  const configuredMethods = methods.filter((method) =>
    isMcpPluginMethodConfigured(method, mcpServersKnown),
  );
  return {
    connectedCount:
      connections.filter((connection) => connection.connected).length +
      servers.filter((server) => server.status === "connected").length,
    needsAttention:
      connections.some((connection) => !connection.connected) ||
      // A plugin that declared no server is not asking for anything: the
      // servers that could need attention are the ones that exist, and an
      // empty list is as often a list that has not arrived. The rows that
      // read this summary have no way to tell those two apart, so neither
      // draws a badge the dialog would then have to explain away.
      configuredMethods.some((method) =>
        method.servers.some((server) => server.status !== "connected"),
      ),
    configured: connections.length > 0 || configuredMethods.length > 0,
  };
}

/**
 * Whether a server has ever been signed in to.
 *
 * `hasOAuth` is the daemon's answer to "are there stored tokens for this
 * server", and `hasStaticAuth` the same question for a hand-configured
 * header. A server that is connected right now is authorized by definition,
 * whichever of the two got it there. A server with none of the three has only
 * been declared: something installed it, nobody has authorized it.
 */
export function mcpServerIsAuthorized(server: McpServerEntry): boolean {
  return (
    server.status === "connected" || server.hasOAuth || server.hasStaticAuth
  );
}

/**
 * Whether a plugin method stands for an integration the user actually has.
 *
 * Installing the plugin is only half of connecting: it declares the server,
 * and the sign-in that follows is what makes the integration real. A plugin
 * whose one server was never authorized is what a cancelled or failed
 * sign-in leaves behind, so it belongs back among the integrations still on
 * offer, where its tile can finish the job it started.
 *
 * Everything the tile cannot finish stays here, where the dialog can: a
 * plugin that declared several servers has no single one to sign in to, one
 * whose servers are local commands has nothing to sign in to at all, and one
 * that declared nothing has only itself to be taken away. The test is the
 * connect sequence's own `pluginAuthTarget`, so an integration is offered
 * exactly when pressing + on it would reach a server.
 *
 * `mcpServersKnown` is false while the server list has not arrived or failed
 * to load. A list that is missing and a plugin whose servers are all
 * unauthorized are the same empty array, and only one of them is an answer:
 * until the real one lands, the install is the better guess, because it
 * leaves a connected integration where the user last saw it.
 */
export function isMcpPluginMethodConfigured(
  method: McpPluginMethod,
  mcpServersKnown = true,
): boolean {
  if (!mcpServersKnown) {
    return Boolean(method.definition.installed) || method.servers.length > 0;
  }
  if (method.servers.some(mcpServerIsAuthorized)) {
    return true;
  }
  return (
    Boolean(method.definition.installed) &&
    pluginAuthTarget(method.servers) === null
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
  definitions: McpPluginDefinition[] = [],
  /** False while the MCP server list has not arrived or failed to load. */
  mcpServersKnown = true,
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
          configured: summarizeIntegrationConnections(
            accounts,
            alternatives,
            mcpServersKnown,
          ).configured,
          category: integrationCategory(provider.category),
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
          configured: isMcpPluginMethodConfigured(method, mcpServersKnown),
          category: method.definition.category ?? null,
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
          category: null,
          server,
        }),
      ),
  ];
}

export function filterIntegrationItems(
  items: IntegrationItem[],
  searchText: string,
  category: IntegrationCategory | null = null,
): IntegrationItem[] {
  const needle = searchText.trim().toLocaleLowerCase();
  return items
    .filter((item) => !category || item.category === category)
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
