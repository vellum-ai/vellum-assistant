import { z } from "zod";

import { getSubagentManager } from "../../subagent/index.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { resolveSubagentId, subagentRefInputSchema } from "./resolve.js";

export const subagentMessageInputSchema = z.looseObject({
  ...subagentRefInputSchema.shape,
  content: nullAsOmitted(z.string()),
});

export async function executeSubagentMessage(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = subagentMessageInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("subagent_message", parsedInput.error);
  }
  const parsed = parsedInput.data;
  const subagentId = resolveSubagentId(parsed, context);
  const content = parsed.content;

  if (!subagentId && parsed.label) {
    return {
      content: `No subagent found with label "${parsed.label}".`,
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

  const result = await manager.sendMessage(subagentId, content, {
    cronRunId: context.cronRunId ?? null,
  });

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
