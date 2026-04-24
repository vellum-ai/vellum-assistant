/**
 * App Builder for Web feature gate.
 *
 * Single source of truth for whether the web app builder is enabled.
 * Delegates to the unified feature-flag resolver so that config overrides
 * and registry defaults are respected uniformly.
 *
 * The flag key uses simple kebab-case format and is declared in
 * `meta/feature-flags/feature-flag-registry.json`.
 */

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../../config/schema.js";

/** Gate for the web app builder integration. */
export const APP_BUILDER_WEB_FLAG_KEY = "app-builder-web" as const;

/**
 * Whether the web app builder is enabled.
 */
export function isAppBuilderWebEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(APP_BUILDER_WEB_FLAG_KEY, config);
}
