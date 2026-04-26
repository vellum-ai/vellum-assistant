import type { ExecutionContext } from "../permissions/approval-policy.js";
import type { PolicyContext } from "../permissions/types.js";
import type { Tool, ToolContext } from "./types.js";

/**
 * Derive the execution context from the tool context fields.
 * - Guardian + non-interactive → "background" (scheduled jobs, reminders)
 * - Non-interactive (non-guardian) → "headless"
 * - Otherwise → "conversation"
 */
function deriveExecutionContext(context?: ToolContext): ExecutionContext {
  if (context?.isInteractive === false && context.trustClass === "guardian") {
    return "background";
  }
  if (context?.isInteractive === false) {
    return "headless";
  }
  return "conversation";
}

/**
 * Build a PolicyContext from tool metadata and execution context.
 * When executing within a task run, ephemeral permission rules are
 * included so pre-approved tools are auto-allowed without prompting.
 */
export function buildPolicyContext(
  tool: Tool,
  context?: ToolContext,
): PolicyContext {
  const executionContext = deriveExecutionContext(context);

  const conversationId = context?.conversationId;

  if (tool.origin === "skill" || tool.origin === "plugin") {
    return {
      executionTarget: tool.executionTarget,
      executionContext,
      conversationId,
    };
  }

  return {
    executionContext,
    conversationId,
  };
}
