/**
 * Shared helper for computer-use skill wrapper scripts.
 *
 * Each wrapper calls forwardComputerUseProxyTool() to delegate execution to
 * the proxy resolver, which forwards the call to the connected macOS client.
 */

import type { ToolContext, ToolExecutionResult } from '../types.js';

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
      content: `Cannot execute ${toolName}: no proxy resolver available. This tool requires a connected macOS client.`,
      isError: true,
    });
  }
  return context.proxyToolResolver(toolName, input);
}
