import { getSubagentManager } from "../../subagent/index.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { resolveSubagentId } from "./resolve.js";

export async function executeSubagentMessage(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const subagentId = resolveSubagentId(input, context);
  const content = input.content as string;

  if (!subagentId && input.label) {
    return {
      content: `No subagent found with label "${input.label as string}".`,
      isError: true,
    };
  }
  if (!subagentId || !content) {
    return {
      content: '"subagent_id" or "label", and "content" are required.',
      isError: true,
    };
  }

  const manager = getSubagentManager();

  // Ownership check: only the parent conversation can message a subagent.
  const state = manager.getState(subagentId);
  if (!state || state.config.parentConversationId !== context.conversationId) {
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
