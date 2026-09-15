import type { ExecutionTarget } from "../tool-types.js";

export const ASSISTANT_DESKTOP_TOOLS: ReadonlySet<string> = new Set([
  "computer_use_observe",
  "computer_use_click",
  "computer_use_double_click",
  "computer_use_right_click",
  "computer_use_type_text",
  "computer_use_key",
  "computer_use_scroll",
  "computer_use_drag",
  "computer_use_wait",
  "computer_use_done",
  "computer_use_respond",
]);

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
