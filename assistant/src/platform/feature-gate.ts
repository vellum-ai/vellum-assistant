import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getIsPlatform } from "../config/env-registry.js";
import type { AssistantConfig } from "../config/schema.js";

const FLAG_KEY = "platform-features-in-local-mode" as const;

export function arePlatformFeaturesEnabled(
  config?: AssistantConfig,
): boolean {
  if (getIsPlatform()) return true;
  return isAssistantFeatureFlagEnabled(
    FLAG_KEY,
    (config ?? {}) as AssistantConfig,
  );
}
