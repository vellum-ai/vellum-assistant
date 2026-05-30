import type { ExecutionTarget } from "./types.js";

export interface ManifestOverride {
  risk: "low" | "medium" | "high";
  execution_target: "host" | "sandbox";
}

/**
 * Decide a tool's execution target — sandbox (assistant container) or host
 * (guardian's device via host-bridge proxy). Pure: same input → same output.
 *
 * Resolution order:
 *   1. Declared `executionTarget` on the tool wins.
 *   2. Name prefix heuristic — `host_*` / `computer_use_*` ⇒ host.
 *   3. Default sandbox.
 *
 * Called once per tool at load/construction time. The returned value is
 * stamped onto every `Tool`, so runtime reads are just a field read.
 */
export function resolveExecutionTarget(tool: {
  name: string;
  executionTarget?: ExecutionTarget;
}): ExecutionTarget {
  if (tool.executionTarget) return tool.executionTarget;
  if (tool.name.startsWith("host_") || tool.name.startsWith("computer_use_")) {
    return "host";
  }
  return "sandbox";
}
