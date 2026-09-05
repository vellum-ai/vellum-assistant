/**
 * Shared helper for computer-use skill wrapper scripts.
 *
 * Each wrapper calls forwardComputerUseProxyTool() to delegate execution to
 * the proxy resolver, which forwards the call to the connected desktop client.
 */

import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * The wire name the screen-annotation skill's tools forward under.
 *
 * A `computer_use_` name because that prefix is what `surfaceProxyResolver`
 * routes to the connected desktop client, not because pointing is computer
 * use. It is named here rather than in the skill so the resolver can exempt
 * it from the computer-use step budget without importing a bundled skill.
 */
export const POINT_AT_PROXY_TOOL = "computer_use_point_at";

/**
 * Forward a computer-use proxy tool call through the context's proxyToolResolver.
 *
 * Returns a clear error result if the resolver is missing (e.g. when the tool
 * is invoked outside a session with a connected client).
 */
export function forwardComputerUseProxyTool(
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
