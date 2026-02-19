/**
 * subagent_status tool — query the status of one or all subagents.
 */

import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { getSubagentManager } from '../../subagent/index.js';

const definition: ToolDefinition = {
  name: 'subagent_status',
  description: 'Get the status of a specific subagent or list all subagents for the current session. Only use this when the user explicitly asks about subagent status — do NOT poll automatically, as you will be notified when subagents complete.',
  input_schema: {
    type: 'object',
    properties: {
      subagent_id: {
        type: 'string',
        description: 'Optional subagent ID to query. If omitted, returns all subagents for this session.',
      },
    },
    required: [],
  },
};

export const subagentStatusTool: Tool = {
  name: 'subagent_status',
  description: definition.description,
  category: 'orchestration',
  defaultRiskLevel: RiskLevel.Low,

  getDefinition(): ToolDefinition {
    return definition;
  },

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeSubagentStatus(input, context);
  },
};

export async function executeSubagentStatus(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const subagentId = input.subagent_id as string | undefined;
  const manager = getSubagentManager();

  if (subagentId) {
    const state = manager.getState(subagentId);
    if (!state || state.config.parentSessionId !== context.sessionId) {
      return { content: `No subagent found with ID "${subagentId}".`, isError: true };
    }
    return {
      content: JSON.stringify({
        subagentId: state.config.id,
        label: state.config.label,
        status: state.status,
        error: state.error,
        createdAt: state.createdAt,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
        usage: state.usage,
      }),
      isError: false,
    };
  }

  // List all subagents for this parent session.
  const children = manager.getChildrenOf(context.sessionId);
  if (children.length === 0) {
    return { content: 'No subagents found for this session.', isError: false };
  }

  const summary = children.map((s) => ({
    subagentId: s.config.id,
    label: s.config.label,
    status: s.status,
    error: s.error,
  }));

  return { content: JSON.stringify(summary), isError: false };
}
