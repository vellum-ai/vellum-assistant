import type { ExecutionContext } from "../permissions/approval-policy.js";
import type { PolicyContext } from "../permissions/types.js";
import { getTaskRunRules } from "../tasks/ephemeral-permissions.js";
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
  const ephemeralRules = context?.taskRunId
    ? getTaskRunRules(context.taskRunId)
    : undefined;

  const executionContext = deriveExecutionContext(context);

  const conversationId = context?.conversationId;

  if (tool.origin === "skill") {
    return {
      executionTarget: tool.executionTarget,
      ephemeralRules: ephemeralRules?.length ? ephemeralRules : undefined,
      executionContext,
      conversationId,
    };
  }

  return {
    ephemeralRules: ephemeralRules?.length ? ephemeralRules : undefined,
    executionContext,
    conversationId,
  };
}
