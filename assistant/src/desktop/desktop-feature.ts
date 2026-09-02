import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getIsContainerized } from "../config/env-registry.js";
import type { AssistantConfig } from "../config/schema.js";

const POD_DESKTOP_FLAG = "pod-desktop" as const;

/**
 * Whether this daemon serves `/v1/desktop/stream`: the `pod-desktop` flag
 * plus a containerized runtime, since only the assistant image ships the X
 * server, window manager and VNC bridge.
 */
export function isPodDesktopEnabled(
  config: AssistantConfig,
  containerized: boolean = getIsContainerized(),
): boolean {
  return (
    containerized && isAssistantFeatureFlagEnabled(POD_DESKTOP_FLAG, config)
  );
}
