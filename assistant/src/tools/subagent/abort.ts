/**
 * subagent_abort tool — abort a running subagent.
 */

import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { getSubagentManager } from '../../subagent/index.js';

const definition: ToolDefinition = {
  name: 'subagent_abort',
  description: 'Abort a running subagent by ID.',
  input_schema: {
    type: 'object',
    properties: {
      subagent_id: {
        type: 'string',
        description: 'The ID of the subagent to abort.',
      },
    },
    required: ['subagent_id'],
  },
};

export const subagentAbortTool: Tool = {
  name: 'subagent_abort',
  description: definition.description,
  category: 'orchestration',
  defaultRiskLevel: RiskLevel.Low,

  getDefinition(): ToolDefinition {
    return definition;
  },

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeSubagentAbort(input, context);
  },
};

export async function executeSubagentAbort(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const subagentId = input.subagent_id as string;
  if (!subagentId) {
    return { content: '"subagent_id" is required.', isError: true };
  }

  const manager = getSubagentManager();
  const sendToClient = context.sendToClient as ((msg: unknown) => void) | undefined;
  const aborted = manager.abort(
    subagentId,
    sendToClient as ((msg: unknown) => void) | undefined,
    context.sessionId,
    { suppressNotification: true },
  );

  if (!aborted) {
    return {
      content: `Could not abort subagent "${subagentId}". It may not exist or already be in a terminal state.`,
      isError: true,
    };
  }

  return {
    content: JSON.stringify({ subagentId, status: 'aborted', message: 'Subagent aborted successfully.' }),
    isError: false,
  };
}
