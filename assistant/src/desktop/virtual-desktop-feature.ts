import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getIsContainerized, getIsPlatform } from "../config/env-registry.js";
import type { AssistantConfig } from "../config/schema.js";

const VIRTUAL_DESKTOP_FLAG = "assistant-desktop" as const;

/** Gates desktop streaming and control to enabled, platform-hosted containers. */
export function isVirtualDesktopEnabled(
  config: AssistantConfig,
  containerized: boolean = getIsContainerized(),
  platformHosted: boolean = getIsPlatform(),
): boolean {
  return (
    platformHosted &&
    containerized &&
    isAssistantFeatureFlagEnabled(VIRTUAL_DESKTOP_FLAG, config)
  );
}
