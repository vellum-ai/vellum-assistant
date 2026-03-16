import { getSubagentManager } from "../../subagent/index.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export async function executeSubagentMessage(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const subagentId = input.subagent_id as string;
  const content = input.content as string;

  if (!subagentId || !content) {
    return {
      content: 'Both "subagent_id" and "content" are required.',
      isError: true,
    };
  }

  const manager = getSubagentManager();

  // Ownership check: only the parent session can message a subagent.
  const state = manager.getState(subagentId);
  if (!state || state.config.parentSessionId !== context.conversationId) {
    return {
      content: `Could not send message to subagent "${subagentId}". It may not exist or be in a terminal state.`,
      isError: true,
    };
  }

  const result = await manager.sendMessage(subagentId, content);

  if (result === "empty") {
    return {
      content: "Message content is empty or whitespace-only.",
      isError: true,
    };
  }

  if (result !== "sent") {
    return {
      content: `Could not send message to subagent "${subagentId}". It may not exist or be in a terminal state.`,
      isError: true,
    };
  }

  return {
    content: JSON.stringify({
      subagentId,
      message: "Message sent to subagent.",
    }),
    isError: false,
  };
}
