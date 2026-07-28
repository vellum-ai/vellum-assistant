import { z } from "zod";

import {
  resolveByConversation,
  resolveFollowUp,
} from "../../followups/followup-store.js";
import type { FollowUp } from "../../followups/types.js";
import {
  invalidToolInputResult,
  nullAsOmitted,
} from "../shared/zod-tool-schema.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

/**
 * Model-input schema, `safeParse`d at the top of
 * {@link executeFollowupResolve}. Same in-tool pattern and TOOLS.json drift
 * guard as the other bundled-skill tools. The bespoke either-or check below
 * keeps its error message.
 */
export const followupResolveInputSchema = z.looseObject({
  id: nullAsOmitted(z.string()),
  channel: nullAsOmitted(z.string()),
  conversation_id: nullAsOmitted(z.string()),
});

function formatFollowUp(f: FollowUp): string {
  const lines = [
    `Follow-up ${f.id}`,
    `  Channel: ${f.channel}`,
    `  Conversation: ${f.conversationId}`,
    `  Status: ${f.status}`,
  ];
  if (f.contactId) {
    lines.push(`  Contact ID: ${f.contactId}`);
  }
  return lines.join("\n");
}

export async function executeFollowupResolve(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const parsedInput = followupResolveInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidToolInputResult("followup_resolve", parsedInput.error);
  }
  const { id, channel, conversation_id: conversationId } = parsedInput.data;

  if (!id && !(channel && conversationId)) {
    return {
      content:
        "Error: Either id or both channel and conversation_id are required",
      isError: true,
    };
  }

  try {
    if (id) {
      const followUp = resolveFollowUp(id);
      return {
        content: `Resolved follow-up:\n${formatFollowUp(followUp)}`,
        isError: false,
      };
    } else {
      const resolved = resolveByConversation(channel!, conversationId!);
      if (resolved.length === 0) {
        return {
          content: `No pending follow-up found for channel="${channel}" conversation="${conversationId}"`,
          isError: false,
        };
      }
      const summaries = resolved.map(formatFollowUp).join("\n\n");
      return {
        content: `Resolved ${resolved.length} follow-up(s):\n${summaries}`,
        isError: false,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}
