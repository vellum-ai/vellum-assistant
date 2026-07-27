import { z } from "zod";

import { RiskLevel } from "../../permissions/types.js";
import { notifyParentFromChild } from "../../subagent/notify.js";
import {
  invalidToolInputResult,
  toToolInputSchema,
} from "../shared/zod-tool-schema.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

/**
 * Model-input schema, the single source for both runtime validation (via
 * `TOOL_INPUT_SCHEMAS`) and the advertised `input_schema` below. `urgency`
 * catches to `undefined` because the tool has always fallen back to "info"
 * rather than failing the notification over a bad urgency value.
 */
export const notifyParentInputSchema = z.looseObject({
  message: z
    .string({ message: '"message" is required.' })
    .min(1, { message: '"message" is required.' })
    .describe("The notification content for the parent."),
  urgency: z
    .enum(["info", "important", "blocked"])
    .describe(
      "'info' for progress updates, 'important' for key findings, 'blocked' when you need guidance.",
    )
    .optional()
    .catch(undefined),
  activity: z
    .string()
    .describe(
      "Brief non-technical explanation of what you are doing and why, shown as a status update.",
    )
    .optional()
    .catch(undefined),
});

export async function executeSubagentNotifyParent(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsed = notifyParentInputSchema.safeParse(input);
  if (!parsed.success) {
    return invalidToolInputResult("notify_parent", parsed.error);
  }
  const message = parsed.data.message;
  const urgency = parsed.data.urgency ?? "info";

  const sent = notifyParentFromChild(context.conversationId, message, urgency);

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

export const notifyParentTool = {
  name: "notify_parent",
  description:
    "Send a notification to the parent conversation. Use this for important findings, when you're blocked, or when you have preliminary results the parent should know about. Do not overuse — notify for significant findings, not after every tool call.",
  category: "orchestration",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,

  input_schema: toToolInputSchema(notifyParentInputSchema, {
    advertiseRequired: ["activity"],
  }),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeSubagentNotifyParent(input, context);
  },
} satisfies ToolDefinition;
