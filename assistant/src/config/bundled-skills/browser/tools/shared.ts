/**
 * Shared adapter for browser skill wrappers.
 *
 * Each browser tool wrapper delegates to this helper, which maps
 * the `browser_*` tool name to a canonical operation identifier
 * and dispatches through {@link executeBrowserOperation}.
 *
 * This keeps every wrapper as a thin adapter with no independent
 * execution logic — all behavior flows through the shared browser
 * operations contract.
 *
 * NOTE: The current `browser_*` skill tools are compatibility adapters
 * over the canonical browser operations contract. They exist so the
 * LLM-facing tool API remains stable while the CLI (`assistant browser`)
 * consumes the same operations directly. Once the `browser_*` tool
 * names are no longer referenced by clients or the LLM, these wrappers
 * can be removed without changing the CLI or the operations layer.
 */

import {
  browserToolNameToOperation,
  executeBrowserOperation,
} from "../../../../browser/operations.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

/**
 * Execute a browser tool by its `browser_*` tool name.
 *
 * Resolves the tool name to a canonical operation via
 * {@link browserToolNameToOperation}, then dispatches through
 * {@link executeBrowserOperation}. Returns an error result if the
 * tool name does not map to a known operation.
 *
 * @param toolName - The `browser_*` tool name (e.g. `"browser_navigate"`).
 * @param input    - Flat input object from the tool call.
 * @param context  - Tool execution context.
 */
export async function runBrowserTool(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const operation = browserToolNameToOperation(toolName);
  if (!operation) {
    return {
      content: `Error: "${toolName}" does not map to a known browser operation.`,
      isError: true,
    };
  }
  return executeBrowserOperation(operation, input, context);
}
