import {
  isVirtualDesktopPlatform,
  shouldUseVirtualDesktop,
} from "../../desktop/virtual-desktop-feature.js";
import type { ExecutionTarget } from "../tool-types.js";

export function computerUseTarget(
  input: Record<string, unknown>,
  context?: Parameters<typeof shouldUseVirtualDesktop>[0],
): "connected-computer" | "assistant-desktop" {
  // Availability is checked at dispatch, so revocation cannot switch computers.
  const target =
    input.target ??
    (input.target_client_id === undefined &&
    context &&
    shouldUseVirtualDesktop(context, isVirtualDesktopPlatform())
      ? "assistant-desktop"
      : "connected-computer");
  if (target !== "connected-computer" && target !== "assistant-desktop") {
    throw new Error("Choose target connected-computer or assistant-desktop");
  }
  if (target === "assistant-desktop" && input.target_client_id !== undefined) {
    throw new Error("target_client_id only applies to a connected computer");
  }
  if (target === "connected-computer" && input.observation_id !== undefined) {
    throw new Error("observation_id only applies to the assistant desktop");
  }
  return target;
}

export function computerUseExecutionTarget(
  input: Record<string, unknown>,
  context?: Parameters<typeof shouldUseVirtualDesktop>[0],
): ExecutionTarget {
  try {
    return computerUseTarget(input, context) === "assistant-desktop"
      ? "sandbox"
      : "host";
  } catch {
    return "host";
  }
}
