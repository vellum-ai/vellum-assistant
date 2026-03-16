import { getSubagentManager } from "../../subagent/index.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export async function executeSubagentStatus(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const subagentId = input.subagent_id as string | undefined;
  const manager = getSubagentManager();

  if (subagentId) {
    const state = manager.getState(subagentId);
    if (
      !state ||
      state.config.parentConversationId !== context.conversationId
    ) {
      return {
        content: `No subagent found with ID "${subagentId}".`,
        isError: true,
      };
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
  const children = manager.getChildrenOf(context.conversationId);
  if (children.length === 0) {
    return { content: "No subagents found for this session.", isError: false };
  }

  const summary = children.map((s) => ({
    subagentId: s.config.id,
    label: s.config.label,
    status: s.status,
    error: s.error,
  }));

  return { content: JSON.stringify(summary), isError: false };
}
