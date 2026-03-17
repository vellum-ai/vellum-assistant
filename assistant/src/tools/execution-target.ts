import { getTool } from "./registry.js";
import type { ExecutionTarget } from "./types.js";

export interface ManifestOverride {
  risk: "low" | "medium" | "high";
  execution_target: "host" | "sandbox";
}

export function resolveExecutionTarget(
  toolName: string,
  manifestOverride?: ManifestOverride,
): ExecutionTarget {
  const tool = getTool(toolName);
  // Manifest-declared execution target is authoritative - check it first so
  // skill tools with host_/computer_use_ prefixes aren't mis-classified.
  if (tool?.executionTarget) {
    return tool.executionTarget;
  }
  // Check the tool's executionMode metadata - proxy tools run on the connected
  // client (host), not inside the sandbox.
  if (tool?.executionMode === "proxy") {
    return "host";
  }
  // Use manifest metadata for unregistered skill tools so the Permission
  // Simulator shows accurate execution targets instead of defaulting to sandbox.
  if (!tool && manifestOverride) {
    return manifestOverride.execution_target;
  }
  // Prefix heuristics for core tools that don't declare an explicit target.
  if (toolName.startsWith("host_") || toolName.startsWith("computer_use_")) {
    return "host";
  }
  return "sandbox";
}
