import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { RiskLevel } from '../../permissions/types.js';
import type { ToolContext, ToolExecutionResult } from '../types.js';
import { registerTool } from '../registry.js';
import { getDb } from '../../memory/db.js';
import { computeMemoryFingerprint } from '../../memory/fingerprint.js';
import { memoryItems } from '../../memory/schema.js';
import { enqueueMemoryJob } from '../../memory/jobs-store.js';
import type { Playbook, PlaybookAutonomyLevel } from '../../playbooks/types.js';
import { truncate } from '../../util/truncate.js';

const VALID_AUTONOMY_LEVELS = new Set<string>(['auto', 'draft', 'notify']);

export async function executePlaybookCreate(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
  const trigger = input.trigger as string;
  const action = input.action as string;

  if (!trigger || typeof trigger !== 'string') {
    return { content: 'Error: trigger is required and must be a string', isError: true };
  }
  if (!action || typeof action !== 'string') {
    return { content: 'Error: action is required and must be a string', isError: true };
  }

  const channel = typeof input.channel === 'string' ? input.channel : '*';
  const category = typeof input.category === 'string' ? input.category : 'general';
  const autonomyLevel: PlaybookAutonomyLevel =
    typeof input.autonomy_level === 'string' && VALID_AUTONOMY_LEVELS.has(input.autonomy_level)
      ? (input.autonomy_level as PlaybookAutonomyLevel)
      : 'draft';
  const priority = typeof input.priority === 'number' ? input.priority : 0;

  const playbook: Playbook = { trigger, channel, category, action, autonomyLevel, priority };
  const statement = JSON.stringify(playbook);
  const subject = truncate(`Playbook: ${trigger}`, 80, '');
  const scopeId = context.memoryScopeId ?? 'default';

  const fingerprint = computeMemoryFingerprint(scopeId, 'playbook', subject, statement);

  try {
    const db = getDb();

    const existing = db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.fingerprint, fingerprint), eq(memoryItems.scopeId, scopeId)))
      .get();

    if (existing) {
      return {
        content: `A playbook with this exact configuration already exists (ID: ${existing.id}).`,
        isError: false,
      };
    }

    const id = uuid();
    const now = Date.now();

    db.insert(memoryItems).values({
      id,
      kind: 'playbook',
      subject,
      statement,
      status: 'active',
      confidence: 0.95,
      importance: 0.8,
      fingerprint,
      verificationState: 'user_confirmed',
      scopeId,
      firstSeenAt: now,
      lastSeenAt: now,
      lastUsedAt: null,
    }).run();

    enqueueMemoryJob('embed_item', { itemId: id });

    const autonomyLabel = autonomyLevel === 'auto' ? 'execute automatically'
      : autonomyLevel === 'draft' ? 'draft for review' : 'notify only';

    return {
      content: [
        'Playbook created successfully.',
        `  ID: ${id}`,
        `  Trigger: ${trigger}`,
        `  Channel: ${channel}`,
        `  Category: ${category}`,
        `  Action: ${action}`,
        `  Autonomy: ${autonomyLabel}`,
        `  Priority: ${priority}`,
      ].join('\n'),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error creating playbook: ${msg}`, isError: true };
  }
}

registerTool({
  name: 'playbook_create',
  description: 'Create an action playbook — a trigger→action rule that tells the assistant how to handle incoming messages matching a pattern',
  category: 'playbook',
  defaultRiskLevel: RiskLevel.Low,
  getDefinition: () => ({
    name: 'playbook_create',
    description: 'Create an action playbook — a trigger→action rule that tells the assistant how to handle incoming messages matching a pattern',
    input_schema: {
      type: 'object',
      properties: {
        trigger: {
          type: 'string',
          description: 'Pattern or description that triggers this playbook (e.g. "meeting request", "from:ceo@*", "newsletter")',
        },
        action: {
          type: 'string',
          description: 'What to do when the trigger matches — natural language action description (e.g. "check calendar, propose 3 times")',
        },
        channel: {
          type: 'string',
          description: 'Channel this rule applies to (e.g. "email", "slack"), or "*" for all channels. Defaults to "*".',
        },
        category: {
          type: 'string',
          description: 'Free-form category for grouping (e.g. "scheduling", "triage"). Defaults to "general".',
        },
        autonomy_level: {
          type: 'string',
          enum: ['auto', 'draft', 'notify'],
          description: 'How much autonomy: "auto" = execute automatically, "draft" = draft for review, "notify" = notify only. Defaults to "draft".',
        },
        priority: {
          type: 'number',
          description: 'Relative priority — higher numbers take precedence. Defaults to 0.',
        },
      },
      required: ['trigger', 'action'],
    },
  }),
  execute: executePlaybookCreate,
});
