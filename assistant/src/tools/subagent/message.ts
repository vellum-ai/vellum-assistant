import { z } from "zod";

import { getSubagentManager } from "../../subagent/index.js";
import { invalidToolInputResult } from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { resolveSubagentId, subagentSelectorFields } from "./resolve.js";

/**
 * Model-input schema. `content` plus one of the selectors is required,
 * enforced in the executor so the combined error message stays intact.
 * `activity` is status-only and never read here, so a malformed value
 * degrades instead of failing the call.
 */
export const subagentMessageInputSchema = z.looseObject({
  ...subagentSelectorFields,
  content: z.string().nullish(),
  activity: z.string().optional().catch(undefined),
});

export async function executeSubagentMessage(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsed = subagentMessageInputSchema.safeParse(input);
  if (!parsed.success) {
    return invalidToolInputResult("subagent_message", parsed.error);
  }
  const subagentId = resolveSubagentId(parsed.data, context);
  const content = parsed.data.content;

  if (!subagentId && parsed.data.label) {
    return {
      content: `No subagent found with label "${parsed.data.label}".`,
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
