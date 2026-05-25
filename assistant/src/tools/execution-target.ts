import { getTool } from "./registry.js";
import type { ExecutionTarget } from "./types.js";

export interface ManifestOverride {
  risk: "low" | "medium" | "high";
  execution_target: "host" | "sandbox";
}

/**
 * Pure compute used at tool construction / load time. Every `LoadedTool`
 * carries `executionTarget` as a required field; this function is the
 * single place where we decide what value to stamp.
 *
 * - `declared` wins (skill manifest, factory, hand-written tool).
 * - `executionMode === "proxy"` => host (proxied tools run on the connected client).
 * - Prefix heuristic catches anything still unset (`host_*` / `computer_use_*`).
 * - Default: sandbox.
 */
export function computeExecutionTarget(
  name: string,
  declared?: ExecutionTarget,
  executionMode?: "local" | "proxy",
): ExecutionTarget {
  if (declared) return declared;
  if (executionMode === "proxy") return "host";
  if (name.startsWith("host_") || name.startsWith("computer_use_")) {
    return "host";
  }
  return "sandbox";
}

/**
 * Runtime reader. For registered tools, returns the value stamped at load
 * time. For unregistered tools (Permission Simulator's "what would this
 * tool do?" path), falls back to manifest metadata or `computeExecutionTarget`.
 */
export function resolveExecutionTarget(
  toolName: string,
  manifestOverride?: ManifestOverride,
): ExecutionTarget {
  const tool = getTool(toolName);
  if (tool) return tool.executionTarget;
  if (manifestOverride) return manifestOverride.execution_target;
  return computeExecutionTarget(toolName);
}
