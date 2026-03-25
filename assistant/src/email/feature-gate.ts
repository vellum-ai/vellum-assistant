/**
 * Email integration feature gate.
 *
 * Single source of truth for whether the email integration is enabled.
 * Delegates to the unified feature-flag resolver so that config overrides
 * and registry defaults are respected uniformly.
 *
 * The flag key uses simple kebab-case format and is declared in
 * `meta/feature-flags/feature-flag-registry.json`.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";

/** Gate for the entire email integration. */
export const EMAIL_FLAG_KEY = "email-channel" as const;

/**
 * Whether the email integration is enabled.
 */
export function isEmailEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(EMAIL_FLAG_KEY, config);
}
