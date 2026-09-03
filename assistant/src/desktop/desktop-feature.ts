import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getIsContainerized } from "../config/env-registry.js";
import type { AssistantConfig } from "../config/schema.js";

const ASSISTANT_DESKTOP_FLAG = "assistant-desktop" as const;

/**
 * Whether this daemon serves `/v1/desktop/stream`: the `assistant-desktop` flag
 * plus a containerized runtime, since only the assistant image ships the X
 * server, window manager and VNC bridge.
 */
export function isAssistantDesktopEnabled(
  config: AssistantConfig,
  containerized: boolean = getIsContainerized(),
): boolean {
  return (
    containerized &&
    isAssistantFeatureFlagEnabled(ASSISTANT_DESKTOP_FLAG, config)
  );
}
