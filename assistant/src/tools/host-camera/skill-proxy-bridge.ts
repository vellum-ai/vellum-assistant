import type { ToolContext, ToolExecutionResult } from "../types.js";

export function forwardHostCameraProxyTool(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (!context.proxyToolResolver) {
    return Promise.resolve({
      content: `Cannot execute ${toolName}: no proxy resolver available. This tool requires a connected desktop client.`,
      isError: true,
    });
  }
  return context.proxyToolResolver(toolName, input);
}
