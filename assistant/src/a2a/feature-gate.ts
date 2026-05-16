import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";

const A2A_FLAG_KEY = "a2a-channel" as const;

export function isA2AEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(A2A_FLAG_KEY, config);
}
