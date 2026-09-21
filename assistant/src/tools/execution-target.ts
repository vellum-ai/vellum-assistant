import type { ExecutionTarget } from "./tool-types.js";
import type { Tool, ToolContext } from "./types.js";

export interface ManifestOverride {
  risk: "low" | "medium" | "high";
  execution_target: "host" | "sandbox";
}

/** With no invocation input, returns the tool's default boundary. */
export function resolveExecutionTarget(
  tool: {
    name: string;
    executionTarget?: ExecutionTarget;
    getExecutionTarget?: Tool["getExecutionTarget"];
  },
  input?: Record<string, unknown>,
  context?: ToolContext,
): ExecutionTarget {
  if (input && tool.getExecutionTarget) {
    return tool.getExecutionTarget(input, context);
  }
  if (tool.executionTarget) {
    return tool.executionTarget;
  }
  if (tool.name.startsWith("host_") || tool.name.startsWith("computer_use_")) {
    return "host";
  }
  return "sandbox";
}
