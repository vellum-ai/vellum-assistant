import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { createFollowUp } from '../../followups/followup-store.js';
import { getContact } from '../../contacts/contact-store.js';
import type { FollowUp } from '../../followups/types.js';

function formatFollowUp(f: FollowUp): string {
  const lines = [
    `Follow-up ${f.id}`,
    `  Channel: ${f.channel}`,
    `  Thread: ${f.threadId}`,
    `  Status: ${f.status}`,
    `  Sent at: ${new Date(f.sentAt).toISOString()}`,
  ];
  if (f.contactId) lines.push(`  Contact ID: ${f.contactId}`);
  if (f.expectedResponseBy) {
    lines.push(`  Expected response by: ${new Date(f.expectedResponseBy).toISOString()}`);
  }
  if (f.reminderCronId) lines.push(`  Reminder cron: ${f.reminderCronId}`);
  return lines.join('\n');
}

const definition: ToolDefinition = {
  name: 'followup_create',
  description: 'Create a follow-up tracker for a sent message. Tracks conversations awaiting a response across channels (email, Slack, WhatsApp, etc.).',
  input_schema: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description: 'Communication channel (e.g. email, slack, whatsapp)',
      },
      thread_id: {
        type: 'string',
        description: 'External thread or conversation identifier on that channel',
      },
      contact_id: {
        type: 'string',
        description: 'Optional contact ID from the contact graph. Used for grace period context.',
      },
      expected_response_hours: {
        type: 'number',
        description: 'Hours to wait for a response before marking as overdue. If omitted, no deadline is set.',
      },
      reminder_cron_id: {
        type: 'string',
        description: 'Optional cron job ID to fire a reminder when overdue',
      },
    },
    required: ['channel', 'thread_id'],
  },
};

class FollowUpCreateTool implements Tool {
  name = 'followup_create';
  description = definition.description;
  category = 'followups';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    return executeFollowupCreate(input, _context);
  }
}

export async function executeFollowupCreate(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const channel = input.channel as string | undefined;
  if (!channel || typeof channel !== 'string' || channel.trim().length === 0) {
    return { content: 'Error: channel is required and must be a non-empty string', isError: true };
  }

  const threadId = input.thread_id as string | undefined;
  if (!threadId || typeof threadId !== 'string' || threadId.trim().length === 0) {
    return { content: 'Error: thread_id is required and must be a non-empty string', isError: true };
  }

  const contactId = input.contact_id as string | undefined;
  const expectedResponseHours = input.expected_response_hours as number | undefined;
  const reminderCronId = input.reminder_cron_id as string | undefined;

  // Validate contact exists if provided
  if (contactId) {
    const contact = getContact(contactId);
    if (!contact) {
      return { content: `Error: Contact "${contactId}" not found`, isError: true };
    }
  }

  if (expectedResponseHours !== undefined && (typeof expectedResponseHours !== 'number' || expectedResponseHours <= 0)) {
    return { content: 'Error: expected_response_hours must be a positive number', isError: true };
  }

  try {
    const now = Date.now();
    const expectedResponseBy = expectedResponseHours
      ? now + expectedResponseHours * 60 * 60 * 1000
      : null;

    const followUp = createFollowUp({
      channel: channel.trim(),
      threadId: threadId.trim(),
      contactId: contactId ?? null,
      sentAt: now,
      expectedResponseBy,
      reminderCronId: reminderCronId ?? null,
    });

    return {
      content: `Created follow-up:\n${formatFollowUp(followUp)}`,
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}

export const followupCreateTool = new FollowUpCreateTool();
