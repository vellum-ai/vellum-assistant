import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { searchContacts } from '../../contacts/contact-store.js';
import type { ContactWithChannels } from '../../contacts/types.js';

function formatContactSummary(c: ContactWithChannels): string {
  const parts = [`- **${c.displayName}** (ID: ${c.id})`];
  if (c.relationship) parts.push(`  Relationship: ${c.relationship}`);
  parts.push(`  Importance: ${c.importance.toFixed(2)} | Interactions: ${c.interactionCount}`);
  if (c.channels.length > 0) {
    const channelList = c.channels
      .map((ch) => `${ch.type}:${ch.address}${ch.isPrimary ? '*' : ''}`)
      .join(', ');
    parts.push(`  Channels: ${channelList}`);
  }
  return parts.join('\n');
}

const definition: ToolDefinition = {
  name: 'contact_search',
  description: 'Search for contacts by name, channel address, relationship type, or other criteria. Returns matching contacts with their channel information.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search by display name (partial match)',
      },
      channel_address: {
        type: 'string',
        description: 'Search by channel address (email, phone, handle — partial match)',
      },
      channel_type: {
        type: 'string',
        description: 'Filter by channel type when searching by address (email, slack, whatsapp, phone, etc.)',
      },
      relationship: {
        type: 'string',
        description: 'Filter by relationship type (exact match)',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return (default 20, max 100)',
      },
    },
    required: [],
  },
};

export async function executeContactSearch(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const query = input.query as string | undefined;
  const channelAddress = input.channel_address as string | undefined;
  const channelType = input.channel_type as string | undefined;
  const relationship = input.relationship as string | undefined;
  const limit = input.limit as number | undefined;

  if (!query && !channelAddress && !relationship) {
    return {
      content: 'Error: At least one search criterion is required (query, channel_address, or relationship)',
      isError: true,
    };
  }

  try {
    const results = searchContacts({
      query,
      channelAddress,
      channelType,
      relationship,
      limit,
    });

    if (results.length === 0) {
      return { content: 'No contacts found matching the search criteria.', isError: false };
    }

    const lines = [`Found ${results.length} contact(s):\n`];
    for (const contact of results) {
      lines.push(formatContactSummary(contact));
    }

    return { content: lines.join('\n'), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}

class ContactSearchTool implements Tool {
  name = 'contact_search';
  description = definition.description;
  category = 'contacts';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeContactSearch(input, context);
  }
}

registerTool(new ContactSearchTool());
