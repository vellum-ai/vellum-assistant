import type { ExecutionTarget } from "../tool-types.js";

export function computerUseTarget(
  input: Record<string, unknown>,
): "connected-computer" | "assistant-desktop" {
  const target = input.target ?? "connected-computer";
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
): ExecutionTarget {
  try {
    return computerUseTarget(input) === "assistant-desktop"
      ? "sandbox"
      : "host";
  } catch {
    return "host";
  }
}
