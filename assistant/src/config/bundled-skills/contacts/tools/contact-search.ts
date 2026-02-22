import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { searchContacts } from '../../../../contacts/contact-store.js';
import type { ContactWithChannels } from '../../../../contacts/types.js';

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

export { executeContactSearch as run };
