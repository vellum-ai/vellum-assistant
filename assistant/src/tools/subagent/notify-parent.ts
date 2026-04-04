import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import { getSubagentManager } from "../../subagent/index.js";
import { registerTool } from "../registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

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

class NotifyParentTool implements Tool {
  name = "notify_parent";
  description =
    "Send a notification to the parent conversation. Use this for important findings, when you're blocked, or when you have preliminary results the parent should know about. Do not overuse — notify for significant findings, not after every tool call.";
  category = "orchestration";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The notification content for the parent.",
          },
          urgency: {
            type: "string",
            enum: ["info", "important", "blocked"],
            description:
              "'info' for progress updates, 'important' for key findings, 'blocked' when you need guidance.",
          },
          activity: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are doing and why, shown to the user as a status update.",
          },
        },
        required: ["message", "activity"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeSubagentNotifyParent(input, context);
  }
}

export const notifyParentTool = new NotifyParentTool();
registerTool(notifyParentTool);
