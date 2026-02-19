import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
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

const definition: ToolDefinition = {
  name: 'followup_resolve',
  description: 'Manually resolve a follow-up by ID, or auto-resolve by channel + thread ID when a response is received.',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Follow-up ID to resolve directly',
      },
      channel: {
        type: 'string',
        description: 'Channel to match (used with thread_id for auto-resolution)',
      },
      thread_id: {
        type: 'string',
        description: 'Thread ID to match (used with channel for auto-resolution)',
      },
    },
    required: [],
  },
};

class FollowUpResolveTool implements Tool {
  name = 'followup_resolve';
  description = definition.description;
  category = 'followups';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    return executeFollowupResolve(input, _context);
  }
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

export const followupResolveTool = new FollowUpResolveTool();
