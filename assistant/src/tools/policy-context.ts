import type { PolicyContext } from '../permissions/types.js';
import type { Tool, ToolContext } from './types.js';
import { getTaskRunRules } from '../tasks/ephemeral-permissions.js';

/**
 * Build a PolicyContext from tool metadata and execution context.
 * When executing within a task run, ephemeral permission rules are
 * included so pre-approved tools are auto-allowed without prompting.
 */
export function buildPolicyContext(tool: Tool, context?: ToolContext): PolicyContext | undefined {
  const ephemeralRules = context?.taskRunId
    ? getTaskRunRules(context.taskRunId)
    : undefined;

  if (tool.origin === 'skill') {
    return {
      executionTarget: tool.executionTarget,
      ephemeralRules: ephemeralRules?.length ? ephemeralRules : undefined,
    };
  }

  if (context?.taskRunId && ephemeralRules?.length) {
    return {
      ephemeralRules,
    };
  }

  return undefined;
}
