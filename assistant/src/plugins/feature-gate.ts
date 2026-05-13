/**
 * External-plugin feature gate.
 *
 * Single source of truth for whether the experimental external-plugin
 * surface is enabled. The flag gates both the `assistant plugins` CLI
 * command tree and (in future) the declarative external-plugin loader
 * pathway in the daemon.
 *
 * The flag key uses the simple kebab-case format and is declared in
 * `meta/feature-flags/feature-flag-registry.json`.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";

/** Gate key for the external-plugin surface. */
const EXTERNAL_PLUGINS_FLAG_KEY = "external-plugins" as const;

/** Whether the external-plugin surface is enabled. */
export function isExternalPluginsEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(EXTERNAL_PLUGINS_FLAG_KEY, config);
}
