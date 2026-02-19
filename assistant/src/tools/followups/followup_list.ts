import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { listFollowUps, getOverdueFollowUps } from '../../followups/followup-store.js';
import type { FollowUp, FollowUpStatus } from '../../followups/types.js';

const VALID_STATUSES = ['pending', 'resolved', 'overdue', 'nudged'] as const;

function formatFollowUpSummary(f: FollowUp): string {
  const parts = [`- **${f.channel}** thread:${f.threadId} (ID: ${f.id})`];
  parts.push(`  Status: ${f.status} | Sent: ${new Date(f.sentAt).toISOString()}`);
  if (f.contactId) parts.push(`  Contact: ${f.contactId}`);
  if (f.expectedResponseBy) {
    const deadline = new Date(f.expectedResponseBy);
    const isOverdue = f.status === 'pending' && deadline.getTime() < Date.now();
    parts.push(`  Expected by: ${deadline.toISOString()}${isOverdue ? ' (OVERDUE)' : ''}`);
  }
  return parts.join('\n');
}

const definition: ToolDefinition = {
  name: 'followup_list',
  description: 'List follow-ups with optional filters by status, channel, or contact. Can also show only overdue follow-ups.',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: [...VALID_STATUSES],
        description: 'Filter by status (pending, resolved, overdue, nudged)',
      },
      channel: {
        type: 'string',
        description: 'Filter by communication channel (e.g. email, slack)',
      },
      contact_id: {
        type: 'string',
        description: 'Filter by contact ID',
      },
      overdue_only: {
        type: 'boolean',
        description: 'When true, return only pending follow-ups past their expected response deadline',
      },
    },
    required: [],
  },
};

class FollowUpListTool implements Tool {
  name = 'followup_list';
  description = definition.description;
  category = 'followups';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    return executeFollowupList(input, _context);
  }
}

export async function executeFollowupList(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const status = input.status as FollowUpStatus | undefined;
  const channel = input.channel as string | undefined;
  const contactId = input.contact_id as string | undefined;
  const overdueOnly = input.overdue_only as boolean | undefined;

  if (status && !VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
    return {
      content: `Error: Invalid status "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`,
      isError: true,
    };
  }

  try {
    let results: FollowUp[];

    if (overdueOnly || status === 'overdue') {
      results = getOverdueFollowUps();
      if (channel) results = results.filter((f) => f.channel === channel);
      if (contactId) results = results.filter((f) => f.contactId === contactId);
    } else {
      results = listFollowUps({ status, channel, contactId });
    }

    if (results.length === 0) {
      return { content: 'No follow-ups found matching the criteria.', isError: false };
    }

    const lines = [`Found ${results.length} follow-up(s):\n`];
    for (const followUp of results) {
      lines.push(formatFollowUpSummary(followUp));
    }

    return { content: lines.join('\n'), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}

export const followupListTool = new FollowUpListTool();
