/**
 * subagent_message tool — send a follow-up message to a running subagent.
 */

import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { getSubagentManager } from '../../subagent/index.js';

const definition: ToolDefinition = {
  name: 'subagent_message',
  description: 'Send a follow-up message to a running subagent.',
  input_schema: {
    type: 'object',
    properties: {
      subagent_id: {
        type: 'string',
        description: 'The ID of the subagent to send a message to.',
      },
      content: {
        type: 'string',
        description: 'The message content to send to the subagent.',
      },
    },
    required: ['subagent_id', 'content'],
  },
};

export const subagentMessageTool: Tool = {
  name: 'subagent_message',
  description: definition.description,
  category: 'orchestration',
  defaultRiskLevel: RiskLevel.Low,

  getDefinition(): ToolDefinition {
    return definition;
  },

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeSubagentMessage(input, context);
  },
};

export async function executeSubagentMessage(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const subagentId = input.subagent_id as string;
  const content = input.content as string;

  if (!subagentId || !content) {
    return { content: 'Both "subagent_id" and "content" are required.', isError: true };
  }

  const manager = getSubagentManager();

  // Ownership check: only the parent session can message a subagent.
  const state = manager.getState(subagentId);
  if (!state || state.config.parentSessionId !== context.sessionId) {
    return {
      content: `Could not send message to subagent "${subagentId}". It may not exist or be in a terminal state.`,
      isError: true,
    };
  }

  const sent = manager.sendMessage(subagentId, content);

  if (!sent) {
    return {
      content: `Could not send message to subagent "${subagentId}". It may not exist or be in a terminal state.`,
      isError: true,
    };
  }

  return {
    content: JSON.stringify({ subagentId, message: 'Message sent to subagent.' }),
    isError: false,
  };
}
