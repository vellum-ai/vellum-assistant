import { getMessages } from "../../memory/conversation-crud.js";
import { getSubagentManager, TERMINAL_STATUSES } from "../../subagent/index.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export async function executeSubagentRead(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const subagentId = input.subagent_id as string;
  if (!subagentId) {
    return { content: '"subagent_id" is required.', isError: true };
  }

  const manager = getSubagentManager();
  const state = manager.getState(subagentId);
  if (!state) {
    return {
      content: `No subagent found with ID "${subagentId}".`,
      isError: true,
    };
  }

  // Ownership check: only the parent conversation can read a subagent's output.
  if (state.config.parentConversationId !== context.conversationId) {
    return {
      content: `No subagent found with ID "${subagentId}".`,
      isError: true,
    };
  }

  if (!TERMINAL_STATUSES.has(state.status)) {
    return {
      content: `Subagent "${state.config.label}" is still ${state.status}. Wait for it to finish.`,
      isError: false,
    };
  }

  // Read the subagent's conversation messages from DB.
  const dbMessages = getMessages(state.conversationId);
  if (!dbMessages || dbMessages.length === 0) {
    return {
      content: "No messages found in subagent conversation.",
      isError: true,
    };
  }

  // Extract assistant messages only — that's the subagent's output.
  const output: string[] = [];
  for (const msg of dbMessages) {
    if (msg.role !== "assistant") continue;
    try {
      const content = JSON.parse(msg.content);
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            output.push(block.text);
          }
        }
      } else if (typeof content === "string") {
        output.push(content);
      }
    } catch {
      // Content might be plain text.
      output.push(msg.content);
    }
  }

  if (output.length === 0) {
    return { content: "Subagent produced no text output.", isError: false };
  }

  return {
    content: output.join("\n\n"),
    isError: false,
  };
}
