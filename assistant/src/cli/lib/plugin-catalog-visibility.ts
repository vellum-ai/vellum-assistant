import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import type { PluginCatalog } from "./search-plugins.js";

export const MCP_CATALOG_QA_INTEGRATIONS_FLAG = "mcp-catalog-qa-integrations";

const MCP_CATALOG_QA_INTEGRATION_NAMES = new Set([
  "gamma",
  "guru",
  "intercom",
  "ramp",
  "semrush",
  "typeform",
]);

export type PluginCatalogFeatureFlagResolver = (key: string) => boolean;

/**
 * Hide catalog entries whose OAuth flows are still being validated. Installed
 * plugins are unaffected because this filter only applies to catalog reads.
 */
export function filterPluginCatalogByFeatureFlags(
  catalog: PluginCatalog,
  isFeatureFlagEnabled: PluginCatalogFeatureFlagResolver = isAssistantFeatureFlagEnabled,
): PluginCatalog {
  if (isFeatureFlagEnabled(MCP_CATALOG_QA_INTEGRATIONS_FLAG)) {
    return catalog;
  }

  const matches = catalog.matches.filter(
    (match) => !MCP_CATALOG_QA_INTEGRATION_NAMES.has(match.name),
  );
  return matches.length === catalog.matches.length
    ? catalog
    : { ...catalog, matches };
}
