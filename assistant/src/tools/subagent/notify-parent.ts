import { z } from "zod";

import { RiskLevel } from "../../permissions/types.js";
import { notifyParentFromChild } from "../../subagent/notify.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
  toToolInputSchema,
} from "../shared/zod-tool-schema.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

/**
 * Model-input schema, the single source for both runtime validation (via
 * `TOOL_INPUT_SCHEMAS`) and the advertised `input_schema` below. `message`
 * stays runtime-optional (`advertiseRequired`) so the bespoke
 * '"message" is required.' check keeps its test-asserted error; `urgency`
 * catches to `undefined` so a malformed value degrades to "info" instead of
 * forwarding garbage to the parent's notification.
 */
export const notifyParentInputSchema = z.looseObject({
  message: nullAsOmitted(
    z.string().describe("The notification content for the parent."),
  ),
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

  if (!message) {
    return { content: '"message" is required.', isError: true };
  }

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
    advertiseRequired: ["message", "activity"],
  }),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    return executeSubagentNotifyParent(input, context);
  },
} satisfies ToolDefinition;
