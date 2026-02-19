import type { ToolContext, ToolExecutionResult } from '../types.js';
import { upsertContact } from '../../contacts/contact-store.js';

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
