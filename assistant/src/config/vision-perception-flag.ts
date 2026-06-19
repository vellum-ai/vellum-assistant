import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import type { AssistantConfig } from "./schema.js";

const VISION_PERCEPTION_FLAG = "vision-perception" as const;

export function isVisionPerceptionEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(VISION_PERCEPTION_FLAG, config);
}
