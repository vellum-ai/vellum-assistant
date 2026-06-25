import {
  resolveByConversation,
  resolveFollowUp,
} from "../../followups/followup-store.js";
import type { FollowUp } from "../../followups/types.js";
import type { ToolContext, ToolExecutionResult } from "../types.js";

function formatFollowUp(f: FollowUp): string {
  const lines = [
    `Follow-up ${f.id}`,
    `  Channel: ${f.channel}`,
    `  Conversation: ${f.conversationId}`,
    `  Status: ${f.status}`,
  ];
  if (f.contactId) lines.push(`  Contact ID: ${f.contactId}`);
  return lines.join("\n");
}

export async function executeFollowupResolve(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = input.id as string | undefined;
  const channel = input.channel as string | undefined;
  const conversationId = input.conversation_id as string | undefined;

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
