import { z } from "zod";

import { getMessages } from "../../persistence/conversation-crud.js";
import { extractTextFromStoredMessageContent } from "../../persistence/message-content.js";
import { getSubagentManager, TERMINAL_STATUSES } from "../../subagent/index.js";
import { invalidToolInputResult } from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";
import { resolveSubagentId, subagentSelectorFields } from "./resolve.js";

/**
 * Model-input schema. `last_n` catches to `undefined` because the tool has
 * always silently ignored a malformed value and returned all messages.
 * `activity` is status-only and never read here, so a malformed value
 * degrades instead of failing the call.
 */
export const subagentReadInputSchema = z.looseObject({
  ...subagentSelectorFields,
  last_n: z.number().nullish().catch(undefined),
  activity: z.string().optional().catch(undefined),
});

export async function executeSubagentRead(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsed = subagentReadInputSchema.safeParse(input);
  if (!parsed.success) {
    return invalidToolInputResult("subagent_read", parsed.error);
  }
  const subagentId = resolveSubagentId(parsed.data, context);
  if (!subagentId && parsed.data.label) {
    return {
      content: `No subagent found with label "${parsed.data.label}".`,
      isError: true,
    };
  }
  if (!subagentId) {
    return {
      content: '"subagent_id" or "label" is required.',
      isError: true,
    };
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

  // Extract assistant messages only - that's the subagent's output.
  // Group text blocks by message so last_n slices messages, not blocks.
  const messageTexts: string[] = [];
  for (const msg of dbMessages) {
    if (msg.role !== "assistant") {
      continue;
    }
    const blocks: string[] = [];
    try {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            blocks.push(block.text);
          }
        }
      } else if (typeof content === "string") {
        blocks.push(content);
      }
    } catch {
      blocks.push(extractTextFromStoredMessageContent(msg.content));
    }
    if (blocks.length > 0) {
      messageTexts.push(blocks.join("\n\n"));
    }
  }

  if (messageTexts.length === 0) {
    return { content: "Subagent produced no text output.", isError: false };
  }

  const lastN =
    typeof parsed.data.last_n === "number" && parsed.data.last_n > 0
      ? parsed.data.last_n
      : undefined;
  const sliced = lastN ? messageTexts.slice(-lastN) : messageTexts;

  return {
    content: sliced.join("\n\n"),
    isError: false,
  };
}
