import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import type { OAuthProviderRow } from "./oauth-store.js";

/**
 * Return true if the provider should be visible to external consumers
 * (CLI, gateway API). A provider is hidden when it declares a featureFlag
 * and that flag is currently disabled, UNLESS the provider also has a
 * managedServiceConfigKey — in that case the provider already existed as
 * a BYO integration and the flag only gates managed-mode visibility (not
 * the entire provider).
 */
export function isProviderVisible(
  row: OAuthProviderRow,
  config: AssistantConfig,
): boolean {
  if (!row.featureFlag) return true;
  if (row.managedServiceConfigKey) return true;
  return isAssistantFeatureFlagEnabled(row.featureFlag, config);
}
