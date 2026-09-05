/**
 * Shared helper for computer-use skill wrapper scripts.
 *
 * Each wrapper calls forwardComputerUseProxyTool() to delegate execution to
 * the proxy resolver, which forwards the call to the connected desktop client.
 */

import { throwIfCancelled } from "../shared/abort.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Session teardown, which runs even on a cancelled turn: refusing it would
 * leave the computer-use session the model opened running with nothing left to
 * close it.
 */
const TEARDOWN_TOOLS: ReadonlySet<string> = new Set(["computer_use_done"]);

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
  // Every non-teardown call actuates the user's desktop: a click, a keystroke,
  // an app launch, an AppleScript run.
  if (!TEARDOWN_TOOLS.has(toolName)) {
    throwIfCancelled(context);
  }
  if (!context.proxyToolResolver) {
    return Promise.resolve({
      content: `Cannot execute ${toolName}: no proxy resolver available. This tool requires a connected desktop client.`,
      isError: true,
    });
  }
  return context.proxyToolResolver(toolName, input);
}
