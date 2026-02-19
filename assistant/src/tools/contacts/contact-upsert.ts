import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { upsertContact } from '../../contacts/contact-store.js';
import { CHANNEL_TYPES } from '../../contacts/types.js';

function formatContact(c: ReturnType<typeof upsertContact>): string {
  const lines = [
    `Contact ${c.id}`,
    `  Name: ${c.displayName}`,
  ];
  if (c.relationship) lines.push(`  Relationship: ${c.relationship}`);
  lines.push(`  Importance: ${c.importance.toFixed(2)}`);
  if (c.responseExpectation) lines.push(`  Response expectation: ${c.responseExpectation}`);
  if (c.preferredTone) lines.push(`  Preferred tone: ${c.preferredTone}`);
  if (c.interactionCount > 0) lines.push(`  Interactions: ${c.interactionCount}`);
  if (c.channels.length > 0) {
    lines.push('  Channels:');
    for (const ch of c.channels) {
      const primary = ch.isPrimary ? ' (primary)' : '';
      lines.push(`    - ${ch.type}: ${ch.address}${primary}`);
    }
  }
  return lines.join('\n');
}

const definition: ToolDefinition = {
  name: 'contact_upsert',
  description: 'Create or update a contact in the relationship graph. Use this to track people the user interacts with across channels (email, Slack, etc.).',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Contact ID to update. Omit to create a new contact (or auto-match by channel address).',
      },
      display_name: {
        type: 'string',
        description: 'Display name for the contact',
      },
      relationship: {
        type: 'string',
        description: 'Relationship type (e.g. colleague, friend, manager, client, family)',
      },
      importance: {
        type: 'number',
        description: 'Importance score 0-1 (default 0.5). Higher = more important.',
      },
      response_expectation: {
        type: 'string',
        description: 'Expected response speed (e.g. immediate, within_hours, within_day, casual)',
      },
      preferred_tone: {
        type: 'string',
        description: 'Preferred communication tone (e.g. formal, casual, friendly, professional)',
      },
      channels: {
        type: 'array',
        description: 'Communication channels for this contact',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: [...CHANNEL_TYPES],
              description: 'Channel type',
            },
            address: {
              type: 'string',
              description: 'Channel address (email address, Slack handle, phone number, etc.)',
            },
            is_primary: {
              type: 'boolean',
              description: 'Whether this is the primary channel for this type',
            },
          },
          required: ['type', 'address'],
        },
      },
    },
    required: ['display_name'],
  },
};

export async function executeContactUpsert(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const displayName = input.display_name as string | undefined;
  if (!displayName || typeof displayName !== 'string' || displayName.trim().length === 0) {
    return { content: 'Error: display_name is required and must be a non-empty string', isError: true };
  }

  const importance = input.importance as number | undefined;
  if (importance !== undefined && (typeof importance !== 'number' || importance < 0 || importance > 1)) {
    return { content: 'Error: importance must be a number between 0 and 1', isError: true };
  }

  const rawChannels = input.channels as Array<{ type: string; address: string; is_primary?: boolean }> | undefined;
  const channels = rawChannels?.map((ch) => ({
    type: ch.type,
    address: ch.address,
    isPrimary: ch.is_primary,
  }));

  try {
    const contact = upsertContact({
      id: input.id as string | undefined,
      displayName: displayName.trim(),
      relationship: input.relationship as string | undefined,
      importance,
      responseExpectation: input.response_expectation as string | undefined,
      preferredTone: input.preferred_tone as string | undefined,
      channels,
    });

    const isNew = contact.createdAt === contact.updatedAt;
    return {
      content: `${isNew ? 'Created' : 'Updated'} contact:\n${formatContact(contact)}`,
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}

class ContactUpsertTool implements Tool {
  name = 'contact_upsert';
  description = definition.description;
  category = 'contacts';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeContactUpsert(input, context);
  }
}

registerTool(new ContactUpsertTool());
