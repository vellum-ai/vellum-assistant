import type { ExecutionTarget } from "./tool-types.js";

export interface ManifestOverride {
  risk: "low" | "medium" | "high";
  execution_target: "host" | "sandbox";
}

/** With no invocation input, returns the tool's conservative default boundary. */
export function resolveExecutionTarget(
  tool: {
    name: string;
    executionTarget?: ExecutionTarget;
    getExecutionTarget?: (input: Record<string, unknown>) => ExecutionTarget;
  },
  input?: Record<string, unknown>,
): ExecutionTarget {
  if (input && tool.getExecutionTarget) {
    return tool.getExecutionTarget(input);
  }
  if (tool.executionTarget) {
    return tool.executionTarget;
  }
  if (tool.name.startsWith("host_") || tool.name.startsWith("computer_use_")) {
    return "host";
  }
  return "sandbox";
}
