import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import type { OAuthProviderRow } from "./oauth-store.js";

/**
 * Return true if the provider should be visible to external consumers
 * (CLI, gateway API). A provider is hidden when it declares a featureFlag
 * and that flag is currently disabled.
 */
export function isProviderVisible(
  row: OAuthProviderRow,
  config: AssistantConfig,
): boolean {
  if (!row.featureFlag) return true;
  return isAssistantFeatureFlagEnabled(row.featureFlag, config);
}
