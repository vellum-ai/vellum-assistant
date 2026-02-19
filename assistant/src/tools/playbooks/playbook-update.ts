import { and, eq } from 'drizzle-orm';
import { RiskLevel } from '../../permissions/types.js';
import type { ToolContext, ToolExecutionResult } from '../types.js';
import { registerTool } from '../registry.js';
import { getDb } from '../../memory/db.js';
import { computeMemoryFingerprint } from '../../memory/fingerprint.js';
import { memoryItems } from '../../memory/schema.js';
import { enqueueMemoryJob } from '../../memory/jobs-store.js';
import { parsePlaybookStatement } from '../../playbooks/types.js';
import type { Playbook, PlaybookAutonomyLevel } from '../../playbooks/types.js';
import { truncate } from '../../util/truncate.js';

const VALID_AUTONOMY_LEVELS = new Set<string>(['auto', 'draft', 'notify']);

export async function executePlaybookUpdate(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
  const playbookId = input.playbook_id as string;
  if (!playbookId || typeof playbookId !== 'string') {
    return { content: 'Error: playbook_id is required and must be a string', isError: true };
  }

  const scopeId = context.memoryScopeId ?? 'default';

  try {
    const db = getDb();

    const existing = db
      .select()
      .from(memoryItems)
      .where(and(
        eq(memoryItems.id, playbookId),
        eq(memoryItems.kind, 'playbook'),
        eq(memoryItems.scopeId, scopeId),
      ))
      .get();

    if (!existing) {
      return { content: `Error: Playbook with ID "${playbookId}" not found`, isError: true };
    }

    const currentPlaybook = parsePlaybookStatement(existing.statement);
    if (!currentPlaybook) {
      return { content: `Error: Playbook data is corrupted for ID "${playbookId}"`, isError: true };
    }

    // Merge updates onto existing playbook
    const updated: Playbook = {
      trigger: typeof input.trigger === 'string' ? input.trigger : currentPlaybook.trigger,
      channel: typeof input.channel === 'string' ? input.channel : currentPlaybook.channel,
      category: typeof input.category === 'string' ? input.category : currentPlaybook.category,
      action: typeof input.action === 'string' ? input.action : currentPlaybook.action,
      autonomyLevel:
        typeof input.autonomy_level === 'string' && VALID_AUTONOMY_LEVELS.has(input.autonomy_level)
          ? (input.autonomy_level as PlaybookAutonomyLevel)
          : currentPlaybook.autonomyLevel,
      priority: typeof input.priority === 'number' ? input.priority : currentPlaybook.priority,
    };

    const statement = JSON.stringify(updated);
    const subject = truncate(`Playbook: ${updated.trigger}`, 80, '');
    const now = Date.now();

    const fingerprint = computeMemoryFingerprint(scopeId, 'playbook', subject, statement);

    // Check if another playbook already has this fingerprint
    const collision = db
      .select({ id: memoryItems.id })
      .from(memoryItems)
      .where(and(
        eq(memoryItems.fingerprint, fingerprint),
        eq(memoryItems.scopeId, scopeId),
      ))
      .get();
    if (collision && collision.id !== existing.id) {
      return {
        content: `Error: Another playbook with this exact configuration already exists (ID: ${collision.id}).`,
        isError: true,
      };
    }

    db.update(memoryItems)
      .set({
        subject,
        statement,
        fingerprint,
        lastSeenAt: now,
        verificationState: 'user_confirmed',
      })
      .where(eq(memoryItems.id, existing.id))
      .run();

    enqueueMemoryJob('embed_item', { itemId: existing.id });

    const autonomyLabel = updated.autonomyLevel === 'auto' ? 'execute automatically'
      : updated.autonomyLevel === 'draft' ? 'draft for review' : 'notify only';

    return {
      content: [
        'Playbook updated successfully.',
        `  ID: ${existing.id}`,
        `  Trigger: ${updated.trigger}`,
        `  Channel: ${updated.channel}`,
        `  Category: ${updated.category}`,
        `  Action: ${updated.action}`,
        `  Autonomy: ${autonomyLabel}`,
        `  Priority: ${updated.priority}`,
      ].join('\n'),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error updating playbook: ${msg}`, isError: true };
  }
}

registerTool({
  name: 'playbook_update',
  description: 'Update an existing action playbook rule',
  category: 'playbook',
  defaultRiskLevel: RiskLevel.Low,
  getDefinition: () => ({
    name: 'playbook_update',
    description: 'Update an existing action playbook rule',
    input_schema: {
      type: 'object',
      properties: {
        playbook_id: {
          type: 'string',
          description: 'ID of the playbook to update (from playbook_list results)',
        },
        trigger: {
          type: 'string',
          description: 'Updated trigger pattern',
        },
        action: {
          type: 'string',
          description: 'Updated action description',
        },
        channel: {
          type: 'string',
          description: 'Updated channel ("*" for all)',
        },
        category: {
          type: 'string',
          description: 'Updated category',
        },
        autonomy_level: {
          type: 'string',
          enum: ['auto', 'draft', 'notify'],
          description: 'Updated autonomy level',
        },
        priority: {
          type: 'number',
          description: 'Updated priority',
        },
      },
      required: ['playbook_id'],
    },
  }),
  execute: executePlaybookUpdate,
});
