import type { PolicyContext } from '../permissions/types.js';
import type { Tool, ToolContext } from './types.js';
import { getTaskRunRules } from '../tasks/ephemeral-permissions.js';

/**
 * Build a PolicyContext from tool metadata and execution context. Skill-origin
 * tools carry a principal identifying the owning skill. When executing within
 * a task run, ephemeral permission rules are included so pre-approved tools
 * are auto-allowed without prompting.
 */
export function buildPolicyContext(tool: Tool, context?: ToolContext): PolicyContext | undefined {
  const ephemeralRules = context?.taskRunId
    ? getTaskRunRules(context.taskRunId)
    : undefined;

  if (tool.origin === 'skill') {
    return {
      principal: {
        kind: 'skill',
        id: tool.ownerSkillId,
        version: tool.ownerSkillVersionHash,
      },
      executionTarget: tool.executionTarget,
      ephemeralRules: ephemeralRules?.length ? ephemeralRules : undefined,
    };
  }

  // For non-skill tools in a task run, create a context with task principal
  // and ephemeral rules so pre-approved tools are honored.
  if (context?.taskRunId && ephemeralRules?.length) {
    return {
      principal: {
        kind: 'task',
        id: context.taskRunId,
      },
      ephemeralRules,
    };
  }

  return undefined;
}
