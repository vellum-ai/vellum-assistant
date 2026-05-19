/**
 * Feature-gate predicate for the perception spine.
 *
 * Centralised so every call site (startup, route handlers, future tools)
 * uses the same flag key.
 */

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";

export const PERCEPTION_FLAG = "perception" as const;

export function isPerceptionEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(PERCEPTION_FLAG, config);
}
