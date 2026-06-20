import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import type { AssistantConfig } from "./schema.js";

/** Single source for the `vision-perception` feature-flag key. */
export const VISION_PERCEPTION_FLAG_KEY = "vision-perception";

/** Whether the `vision-perception` feature flag is enabled for this config. */
export function isVisionPerceptionEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(VISION_PERCEPTION_FLAG_KEY, config);
}
