import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { getConfig } from '../config/loader.js';
import { getLogger } from '../util/logger.js';
import { truncate } from '../util/truncate.js';
import { isConflictKindEligible, isStatementConflictEligible } from './conflict-policy.js';
import { createOrUpdatePendingConflict } from './conflict-store.js';
import { getDb } from './db.js';
import { enqueueMemoryJob } from './jobs-store.js';
import { memoryItems } from './schema.js';

const log = getLogger('memory-contradiction-checker');

const CONTRADICTION_LLM_TIMEOUT_MS = 15_000;

type Relationship = 'contradiction' | 'update' | 'complement' | 'ambiguous_contradiction';

interface ClassifyResult {
  relationship: Relationship;
  explanation: string;
}

const CONTRADICTION_SYSTEM_PROMPT = `You are a memory consistency checker. Given two statements about the same subject, determine their relationship.

Classify the relationship as one of:
- "contradiction": The new statement directly contradicts the old statement. They cannot both be true at the same time. Example: "User prefers dark mode" vs "User prefers light mode".
- "update": The new statement provides updated or more specific information that supersedes the old statement, but does not contradict it. Example: "User works at Acme" vs "User works at Acme as a senior engineer".
- "complement": The statements are compatible and provide different, non-overlapping information. Both can coexist. Example: "User likes TypeScript" vs "User prefers functional programming".
- "ambiguous_contradiction": The statements appear to conflict, but there is not enough confidence to invalidate either statement without user clarification.

Be conservative: only classify as "contradiction" when the statements are genuinely incompatible. Prefer "complement" when in doubt.`;

/**
 * Check a newly extracted memory item against existing items for contradictions.
 * Searches for existing active items with similar subject/statement, then uses
 * LLM to classify the relationship and handle accordingly.
 */
export async function checkContradictions(newItemId: string): Promise<void> {
  const db = getDb();
  const newItem = db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.id, newItemId))
    .get();

  if (!newItem || newItem.status !== 'active') {
    log.debug({ newItemId }, 'Skipping contradiction check — item not found or not active');
    return;
  }

  // Find existing active items with similar kind + subject
  const candidates = findSimilarItems(newItem);
  if (candidates.length === 0) {
    log.debug({ newItemId, subject: newItem.subject }, 'No similar items found for contradiction check');
    return;
  }

  const config = getConfig();
  const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.debug('No Anthropic API key available for contradiction checking');
    return;
  }

  if (!isConflictKindEligible(newItem.kind, config.memory.conflicts)) {
    log.debug({ newItemId, kind: newItem.kind }, 'Skipping contradiction check — kind not eligible for conflicts');
    return;
  }

  // Skip if the new item's statement is transient/non-durable
  if (!isStatementConflictEligible(newItem.kind, newItem.statement, config.memory.conflicts)) {
    log.debug({ newItemId, kind: newItem.kind }, 'Skipping contradiction check — statement is transient or non-durable');
    return;
  }

  for (const existing of candidates) {
    // Skip candidate if its statement is transient/non-durable
    if (!isStatementConflictEligible(existing.kind, existing.statement, config.memory.conflicts)) {
      log.debug({ existingId: existing.id }, 'Skipping candidate — statement is transient or non-durable');
      continue;
    }

    try {
      const result = await classifyRelationship(apiKey, existing, newItem);
      await handleRelationship(result, existing, newItem);
      // Only stop when the new item itself is invalidated (update case).
      // For contradiction, the old item is invalidated but the new item remains
      // active and should continue to be checked against remaining candidates.
      // For ambiguous contradiction, we pause retrieval eligibility for the new
      // item and ask for clarification on a later turn.
      if (result.relationship === 'update' || result.relationship === 'ambiguous_contradiction') break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message, newItemId, existingId: existing.id }, 'Contradiction classification failed for pair');
    }
  }
}

interface MemoryItemRow {
  id: string;
  kind: string;
  subject: string;
  statement: string;
  status: string;
  confidence: number;
  importance: number | null;
  scopeId: string;
  lastSeenAt: number;
}

/**
 * Find existing active items that are similar to the given item.
 * Uses LIKE queries on subject and keyword overlap on statement.
 */
function findSimilarItems(item: MemoryItemRow): MemoryItemRow[] {
  const db = getDb();
  const raw = (db as unknown as { $client: { query: (q: string) => { all: (...params: unknown[]) => unknown[] } } }).$client;

  // Extract significant words from subject for LIKE matching
  const subjectWords = item.subject
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/g)
    .filter((w) => w.length >= 3);

  // Extract significant words from statement for additional matching
  const statementWords = item.statement
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/g)
    .filter((w) => w.length >= 3);

  if (subjectWords.length === 0 && statementWords.length === 0) return [];

  // Build LIKE clauses for subject similarity
  const likeClauses: string[] = [];
  for (const word of subjectWords) {
    const escaped = escapeSqlLike(word);
    likeClauses.push(`LOWER(subject) LIKE '%${escaped}%'`);
  }

  // Also match on statement keywords (top 5 longest words for specificity)
  const topStatementWords = statementWords
    .sort((a, b) => b.length - a.length)
    .slice(0, 5);
  for (const word of topStatementWords) {
    const escaped = escapeSqlLike(word);
    likeClauses.push(`LOWER(statement) LIKE '%${escaped}%'`);
  }

  if (likeClauses.length === 0) return [];

  const sqlQuery = `
    SELECT id, kind, subject, statement, status, confidence, importance, scope_id, last_seen_at
    FROM memory_items
    WHERE status = 'active'
      AND invalid_at IS NULL
      AND kind = ?
      AND id <> ?
      AND scope_id = ?
      AND (${likeClauses.join(' OR ')})
    ORDER BY last_seen_at DESC
    LIMIT 10
  `;

  try {
    const rows = raw.query(sqlQuery).all(item.kind, item.id, item.scopeId) as Array<{
      id: string;
      kind: string;
      subject: string;
      statement: string;
      status: string;
      confidence: number;
      importance: number | null;
      scope_id: string;
      last_seen_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      subject: row.subject,
      statement: row.statement,
      status: row.status,
      confidence: row.confidence,
      importance: row.importance,
      scopeId: row.scope_id,
      lastSeenAt: row.last_seen_at,
    }));
  } catch (err) {
    log.warn({ err }, 'Failed to search for similar memory items');
    return [];
  }
}

/**
 * Use LLM to classify the relationship between two memory items.
 */
async function classifyRelationship(
  apiKey: string,
  existingItem: MemoryItemRow,
  newItem: MemoryItemRow,
): Promise<ClassifyResult> {
  const client = new Anthropic({ apiKey });

  const userMessage = [
    `Subject: ${newItem.subject}`,
    '',
    `Old statement: ${existingItem.statement}`,
    `New statement: ${newItem.statement}`,
  ].join('\n');

  const response = await Promise.race([
    client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: CONTRADICTION_SYSTEM_PROMPT,
      tools: [{
        name: 'classify_relationship',
        description: 'Classify the relationship between two memory statements',
        input_schema: {
          type: 'object' as const,
          properties: {
            relationship: {
              type: 'string',
              enum: ['contradiction', 'update', 'complement', 'ambiguous_contradiction'],
              description: 'The relationship between the old and new statements',
            },
            explanation: {
              type: 'string',
              description: 'Brief explanation of why this relationship was chosen',
            },
          },
          required: ['relationship', 'explanation'],
        },
      }],
      tool_choice: { type: 'tool' as const, name: 'classify_relationship' },
      messages: [{ role: 'user' as const, content: userMessage }],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Contradiction check LLM timeout')), CONTRADICTION_LLM_TIMEOUT_MS),
    ),
  ]);

  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock || toolBlock.type !== 'tool_use') {
    throw new Error('No tool_use block in contradiction check response');
  }

  const input = toolBlock.input as { relationship?: string; explanation?: string };
  const relationship = input.relationship as Relationship;
  if (!['contradiction', 'update', 'complement', 'ambiguous_contradiction'].includes(relationship)) {
    throw new Error(`Invalid relationship type: ${relationship}`);
  }

  return {
    relationship,
    explanation: truncate(String(input.explanation ?? ''), 500, ''),
  };
}

/**
 * Handle the classified relationship between an existing and new memory item.
 */
async function handleRelationship(
  result: ClassifyResult,
  existingItem: MemoryItemRow,
  newItem: MemoryItemRow,
): Promise<void> {
  const db = getDb();
  const now = Date.now();

  switch (result.relationship) {
    case 'contradiction': {
      // Invalidate the old item (don't delete for audit trail), set validFrom on new item
      log.info(
        { existingId: existingItem.id, newId: newItem.id, explanation: result.explanation },
        'Contradiction detected — invalidating old item',
      );
      db.update(memoryItems)
        .set({ invalidAt: now })
        .where(eq(memoryItems.id, existingItem.id))
        .run();
      db.update(memoryItems)
        .set({ validFrom: now })
        .where(eq(memoryItems.id, newItem.id))
        .run();
      break;
    }
    case 'update': {
      // Merge info — update old item's statement, bump lastSeenAt
      log.debug(
        { existingId: existingItem.id, newId: newItem.id, explanation: result.explanation },
        'Update detected — merging into existing item',
      );
      db.update(memoryItems)
        .set({
          statement: newItem.statement,
          lastSeenAt: Math.max(existingItem.lastSeenAt, newItem.lastSeenAt),
          confidence: Math.max(existingItem.confidence, newItem.confidence),
        })
        .where(eq(memoryItems.id, existingItem.id))
        .run();
      // Re-embed the existing item so its vector matches the updated statement
      enqueueMemoryJob('embed_item', { itemId: existingItem.id });
      // Invalidate the new item since its content has been merged into the existing one
      db.update(memoryItems)
        .set({ invalidAt: now })
        .where(eq(memoryItems.id, newItem.id))
        .run();
      break;
    }
    case 'complement': {
      // Both items can coexist — no changes needed
      log.debug(
        { existingId: existingItem.id, newId: newItem.id, explanation: result.explanation },
        'Complement detected — keeping both items',
      );
      break;
    }
    case 'ambiguous_contradiction': {
      log.info(
        { existingId: existingItem.id, newId: newItem.id, explanation: result.explanation },
        'Ambiguous contradiction detected — gating candidate pending clarification',
      );
      db.update(memoryItems)
        .set({ status: 'pending_clarification' })
        .where(eq(memoryItems.id, newItem.id))
        .run();
      createOrUpdatePendingConflict({
        scopeId: newItem.scopeId,
        existingItemId: existingItem.id,
        candidateItemId: newItem.id,
        relationship: 'ambiguous_contradiction',
        clarificationQuestion: buildClarificationQuestion(existingItem.statement, newItem.statement),
      });
      break;
    }
  }
}

function escapeSqlLike(s: string): string {
  return s.replace(/'/g, "''").replace(/%/g, '').replace(/_/g, '');
}

function buildClarificationQuestion(existingStatement: string, candidateStatement: string): string {
  const normalize = (input: string): string =>
    truncate(input.replace(/\s+/g, ' ').trim(), 180, '');
  return `I have conflicting notes: "${normalize(existingStatement)}" vs "${normalize(candidateStatement)}". Which one is correct?`;
}
