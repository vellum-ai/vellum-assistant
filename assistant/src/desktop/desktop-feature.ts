import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";

const POD_DESKTOP_FLAG = "pod-desktop" as const;

/**
 * Whether this daemon serves `/v1/desktop/stream`.
 *
 * Requires both the `pod-desktop` flag and a containerized runtime: the X
 * server, window manager and VNC bridge only exist in the assistant image, so
 * a macOS or self-hosted daemon never advertises the surface regardless of
 * the flag.
 */
export function isPodDesktopEnabled(
  config: AssistantConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.IS_CONTAINERIZED === "true" &&
    isAssistantFeatureFlagEnabled(POD_DESKTOP_FLAG, config)
  );
}
