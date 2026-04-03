import { getSubagentManager } from "../../subagent/index.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

export async function executeSubagentNotifyParent(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const message = input.message as string;
  const urgency = (input.urgency as string) || "info";

  if (!message) {
    return { content: '"message" is required.', isError: true };
  }

  const manager = getSubagentManager();
  const sent = manager.notifyParent(context.conversationId, message, urgency);

  if (!sent) {
    return {
      content:
        "Could not notify parent. This tool is only available to subagents.",
      isError: true,
    };
  }

  return {
    content: JSON.stringify({ sent: true, urgency }),
    isError: false,
  };
}
