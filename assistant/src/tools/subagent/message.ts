import type { ToolContext, ToolExecutionResult } from '../types.js';
import { getSubagentManager } from '../../subagent/index.js';

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
