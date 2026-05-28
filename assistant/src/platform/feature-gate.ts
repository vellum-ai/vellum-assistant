import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";

const FLAG_KEY = "platform-features-in-local-mode" as const;

export function arePlatformFeaturesEnabled(
  config?: AssistantConfig,
): boolean {
  return isAssistantFeatureFlagEnabled(
    FLAG_KEY,
    (config ?? {}) as AssistantConfig,
  );
}
