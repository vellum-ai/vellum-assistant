import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import type { AssistantConfig } from "./schema.js";
import { VISION_PERCEPTION_FLAG_KEY } from "./seed-inference-profiles.js";

/** Whether the `vision-perception` feature flag is enabled for this config. */
export function isVisionPerceptionEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(VISION_PERCEPTION_FLAG_KEY, config);
}
