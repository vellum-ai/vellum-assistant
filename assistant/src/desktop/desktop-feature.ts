import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getIsContainerized } from "../config/env-registry.js";
import type { AssistantConfig } from "../config/schema.js";

const ASSISTANT_DESKTOP_FLAG = "assistant-desktop" as const;

/** Gates desktop streaming and control to enabled, containerized assistants. */
export function isAssistantDesktopEnabled(
  config: AssistantConfig,
  containerized: boolean = getIsContainerized(),
): boolean {
  return (
    containerized &&
    isAssistantFeatureFlagEnabled(ASSISTANT_DESKTOP_FLAG, config)
  );
}
