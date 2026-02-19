import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { mergeContacts, getContact } from '../../contacts/contact-store.js';

const definition: ToolDefinition = {
  name: 'contact_merge',
  description: 'Merge two contacts when you discover they are the same person (e.g. same person on email and Slack). Combines channels, keeps the higher importance, and deletes the donor contact.',
  input_schema: {
    type: 'object',
    properties: {
      keep_id: {
        type: 'string',
        description: 'ID of the contact to keep (the surviving contact)',
      },
      merge_id: {
        type: 'string',
        description: 'ID of the contact to merge into the kept contact (will be deleted)',
      },
    },
    required: ['keep_id', 'merge_id'],
  },
};

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

class ContactMergeTool implements Tool {
  name = 'contact_merge';
  description = definition.description;
  category = 'contacts';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return definition;
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return executeContactMerge(input, context);
  }
}

registerTool(new ContactMergeTool());
