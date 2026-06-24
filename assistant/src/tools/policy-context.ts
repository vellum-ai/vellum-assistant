import type { ExecutionContext } from "../permissions/approval-policy.js";
import type { PolicyContext } from "../permissions/types.js";
import { getToolOwner } from "./registry.js";
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

  // Origin/trust/channel signals the checker uses to scope narrow
  // non-interactive auto-grants (e.g. the memory-consolidation skill-authoring
  // grant) to a specific internal origin. Background-job turns populate
  // `requestOrigin`; `trustClass`/`executionChannel` come from the turn's
  // resolved trust context. Undefined for normal interactive turns, so no
  // origin-scoped grant can fire for them.
  const originSignals = {
    requestOrigin: context?.requestOrigin,
    trustClass: context?.trustClass,
    sourceChannel: context?.executionChannel,
  };

  const ownerKind = getToolOwner(tool.name)?.kind;
  if (ownerKind === "skill" || ownerKind === "plugin") {
    return {
      executionTarget: tool.executionTarget,
      executionContext,
      conversationId,
      ...originSignals,
    };
  }

  return {
    executionContext,
    conversationId,
    ...originSignals,
  };
}
