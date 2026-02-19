import type { ToolContext, ToolExecutionResult } from '../types.js';
import { resolveFollowUp, resolveByThread } from '../../followups/followup-store.js';
import type { FollowUp } from '../../followups/types.js';

function formatFollowUp(f: FollowUp): string {
  const lines = [
    `Follow-up ${f.id}`,
    `  Channel: ${f.channel}`,
    `  Thread: ${f.threadId}`,
    `  Status: ${f.status}`,
  ];
  if (f.contactId) lines.push(`  Contact ID: ${f.contactId}`);
  return lines.join('\n');
}

export async function executeFollowupResolve(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const id = input.id as string | undefined;
  const channel = input.channel as string | undefined;
  const threadId = input.thread_id as string | undefined;

  if (!id && !(channel && threadId)) {
    return {
      content: 'Error: Either id or both channel and thread_id are required',
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
      const resolved = resolveByThread(channel!, threadId!);
      if (resolved.length === 0) {
        return {
          content: `No pending follow-up found for channel="${channel}" thread="${threadId}"`,
          isError: false,
        };
      }
      const summaries = resolved.map(formatFollowUp).join('\n\n');
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
