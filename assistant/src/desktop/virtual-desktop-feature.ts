import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getIsContainerized, getIsPlatform } from "../config/env-registry.js";
import type { AssistantConfig } from "../config/schema.js";
import type { ToolContext } from "../tools/types.js";

const VIRTUAL_DESKTOP_FLAG = "assistant-desktop" as const;

/** Gates desktop streaming and control to enabled, platform-hosted containers. */
export function isVirtualDesktopEnabled(
  config?: AssistantConfig,
  containerized: boolean = getIsContainerized(),
  platformHosted: boolean = getIsPlatform(),
): boolean {
  return (
    platformHosted &&
    containerized &&
    isAssistantFeatureFlagEnabled(VIRTUAL_DESKTOP_FLAG, config)
  );
}

/** Web guardian turns default to the streamed desktop; native apps keep their host. */
export function shouldUseVirtualDesktop(
  context: Pick<
    ToolContext,
    "transportInterface" | "clientOs" | "trustClass" | "sourceActorPrincipalId"
  >,
): boolean {
  return (
    context.transportInterface === "web" &&
    context.clientOs !== "macos" &&
    context.clientOs !== "windows" &&
    context.clientOs !== "linux" &&
    context.trustClass === "guardian" &&
    !!context.sourceActorPrincipalId &&
    isVirtualDesktopEnabled()
  );
}

export function supportsVirtualDesktopComputerUse(toolName: string): boolean {
  return [
    "computer_use_observe",
    "computer_use_click",
    "computer_use_type_text",
    "computer_use_key",
    "computer_use_scroll",
    "computer_use_drag",
    "computer_use_wait",
    "computer_use_sequence",
    "computer_use_done",
    "computer_use_respond",
  ].includes(toolName);
}
