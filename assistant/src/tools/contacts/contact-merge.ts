import type { ToolContext, ToolExecutionResult } from '../types.js';
import { mergeContacts, getContact } from '../../contacts/contact-store.js';

export async function executeContactMerge(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const keepId = input.keep_id as string | undefined;
  const mergeId = input.merge_id as string | undefined;

  if (!keepId || typeof keepId !== 'string') {
    return { content: 'Error: keep_id is required', isError: true };
  }
  if (!mergeId || typeof mergeId !== 'string') {
    return { content: 'Error: merge_id is required', isError: true };
  }

  // Show what will be merged for clarity
  const keepContact = getContact(keepId);
  const mergeContact = getContact(mergeId);

  if (!keepContact) {
    return { content: `Error: Contact "${keepId}" not found`, isError: true };
  }
  if (!mergeContact) {
    return { content: `Error: Contact "${mergeId}" not found`, isError: true };
  }

  try {
    const merged = mergeContacts(keepId, mergeId);

    const channelList = merged.channels
      .map((ch) => `  - ${ch.type}: ${ch.address}${ch.isPrimary ? ' (primary)' : ''}`)
      .join('\n');

    return {
      content: [
        `Merged "${mergeContact.displayName}" into "${keepContact.displayName}".`,
        ``,
        `Surviving contact (${merged.id}):`,
        `  Name: ${merged.displayName}`,
        `  Importance: ${merged.importance.toFixed(2)}`,
        `  Interactions: ${merged.interactionCount}`,
        merged.relationship ? `  Relationship: ${merged.relationship}` : null,
        merged.channels.length > 0 ? `  Channels:\n${channelList}` : null,
        ``,
        `Deleted contact: ${mergeContact.displayName} (${mergeId})`,
      ].filter(Boolean).join('\n'),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}
