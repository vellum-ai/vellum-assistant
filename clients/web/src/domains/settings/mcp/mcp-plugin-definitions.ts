import type {
  PluginsGetResponse,
  PluginsSearchGetResponse,
} from "@/generated/daemon/types.gen";

import {
  integrationCategory,
  type McpPluginDefinition,
} from "../integration-items";

type CatalogMatch = PluginsSearchGetResponse["matches"][number];
type InstalledPlugin = PluginsGetResponse["plugins"][number];

export function buildMcpPluginDefinitions(
  matches: readonly CatalogMatch[],
  installedPlugins: readonly InstalledPlugin[],
): McpPluginDefinition[] {
  const installedByName = new Map(
    installedPlugins.map((plugin) => [plugin.name, plugin]),
  );

  return matches.flatMap((match) => {
    const integration = match.integration;
    if (integration?.kind !== "mcp") {
      return [];
    }
    const installed = installedByName.get(match.name);
    return [
      {
        pluginName: match.name,
        displayName: integration.displayName,
        description: match.description ?? integration.displayName,
        documentationUrl: integration.documentationUrl,
        logo: integration.logo,
        oauthProvider: integration.oauthProvider,
        category: integrationCategory(integration.category) ?? undefined,
        setup: integration.setup,
        installed: installed
          ? {
              icon: installed.icon,
              hasIcon: installed.hasIcon,
              iconVersion: installed.iconVersion,
            }
          : undefined,
      },
    ];
  });
}
