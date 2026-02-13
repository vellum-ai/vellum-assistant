import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { AssistantConfig } from '../../config/types.js';
import { getLogger } from '../../util/logger.js';
import { getDb } from '../../memory/db.js';
import { memoryItems } from '../../memory/schema.js';
import { enqueueMemoryJob } from '../../memory/jobs-store.js';
import { searchMemoryItems, formatRelativeTime } from '../../memory/retriever.js';
import type { ToolExecutionResult } from '../types.js';

const log = getLogger('memory-tools');

// ── memory_search ────────────────────────────────────────────────────

export async function handleMemorySearch(
  args: Record<string, unknown>,
  config: AssistantConfig,
): Promise<ToolExecutionResult> {
  const query = args.query;
  if (typeof query !== 'string' || query.trim().length === 0) {
    return { content: 'Error: query is required and must be a non-empty string', isError: true };
  }

  const limit = typeof args.limit === 'number' && args.limit > 0
    ? Math.min(args.limit, 20)
    : 5;

  try {
    const results = searchMemoryItems(query, limit, config);

    if (results.length === 0) {
      return { content: 'No matching memories found.', isError: false };
    }

    const lines: string[] = [`Found ${results.length} memory item(s):\n`];
    for (const result of results) {
      const timeAgo = formatRelativeTime(result.createdAt);
      lines.push(`- **[${result.kind}]** ${result.text}`);
      lines.push(`  ID: ${result.id} | ${timeAgo}`);
    }

    return { content: lines.join('\n'), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, query }, 'memory_search failed');
    return { content: `Error: Memory search failed: ${msg}`, isError: true };
  }
}

// ── memory_save ──────────────────────────────────────────────────────

export async function handleMemorySave(
  args: Record<string, unknown>,
  _config: AssistantConfig,
  conversationId: string,
  messageId: string | undefined,
): Promise<ToolExecutionResult> {
  const statement = args.statement;
  if (typeof statement !== 'string' || statement.trim().length === 0) {
    return { content: 'Error: statement is required and must be a non-empty string', isError: true };
  }

  const kind = args.kind;
  const validKinds = new Set([
    'preference', 'fact', 'decision', 'profile',
    'relationship', 'event', 'opinion', 'instruction',
  ]);
  if (typeof kind !== 'string' || !validKinds.has(kind)) {
    return {
      content: `Error: kind is required and must be one of: ${[...validKinds].join(', ')}`,
      isError: true,
    };
  }

  const subject = typeof args.subject === 'string' && args.subject.trim().length > 0
    ? args.subject.trim().slice(0, 80)
    : inferSubjectFromStatement(statement.trim());

  try {
    const db = getDb();
    const id = uuid();
    const now = Date.now();
    const trimmedStatement = statement.trim().slice(0, 500);

    // Build fingerprint for dedup consistency with items-extractor
    const normalized = `${kind}|${subject.toLowerCase()}|${trimmedStatement.toLowerCase()}`;
    const fingerprint = createHash('sha256').update(normalized).digest('hex');

    // Check for existing item with same fingerprint
    const existing = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.fingerprint, fingerprint))
      .get();

    if (existing) {
      // Update existing item's lastSeenAt and ensure active
      db.update(memoryItems)
        .set({
          status: 'active',
          importance: 0.8,
          lastSeenAt: now,
        })
        .where(eq(memoryItems.id, existing.id))
        .run();

      enqueueMemoryJob('embed_item', { itemId: existing.id });
      return {
        content: `Memory already exists (ID: ${existing.id}). Updated and refreshed.`,
        isError: false,
      };
    }

    db.insert(memoryItems).values({
      id,
      kind,
      subject,
      statement: trimmedStatement,
      status: 'active',
      confidence: 0.95,     // explicit saves have high confidence
      importance: 0.8,       // explicit saves are high importance
      fingerprint,
      firstSeenAt: now,
      lastSeenAt: now,
      lastUsedAt: null,
    }).run();

    enqueueMemoryJob('embed_item', { itemId: id });

    log.debug({ id, kind, subject, conversationId, messageId }, 'Memory item saved via tool');
    return {
      content: `Saved to memory (ID: ${id}).\nKind: ${kind}\nSubject: ${subject}\nStatement: ${trimmedStatement}`,
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'memory_save failed');
    return { content: `Error: Failed to save memory: ${msg}`, isError: true };
  }
}

// ── memory_update ────────────────────────────────────────────────────

export async function handleMemoryUpdate(
  args: Record<string, unknown>,
  _config: AssistantConfig,
): Promise<ToolExecutionResult> {
  const memoryId = args.memory_id;
  if (typeof memoryId !== 'string' || memoryId.trim().length === 0) {
    return { content: 'Error: memory_id is required and must be a non-empty string', isError: true };
  }

  const statement = args.statement;
  if (typeof statement !== 'string' || statement.trim().length === 0) {
    return { content: 'Error: statement is required and must be a non-empty string', isError: true };
  }

  try {
    const db = getDb();
    const existing = db
      .select()
      .from(memoryItems)
      .where(eq(memoryItems.id, memoryId.trim()))
      .get();

    if (!existing) {
      return { content: `Error: Memory item with ID "${memoryId}" not found`, isError: true };
    }

    const now = Date.now();
    const trimmedStatement = statement.trim().slice(0, 500);

    // Recompute fingerprint with updated statement
    const normalized = `${existing.kind}|${existing.subject.toLowerCase()}|${trimmedStatement.toLowerCase()}`;
    const fingerprint = createHash('sha256').update(normalized).digest('hex');

    db.update(memoryItems)
      .set({
        statement: trimmedStatement,
        fingerprint,
        lastSeenAt: now,
        importance: 0.8,
      })
      .where(eq(memoryItems.id, existing.id))
      .run();

    // Queue re-embedding with updated text
    enqueueMemoryJob('embed_item', { itemId: existing.id });

    log.debug({ id: existing.id, kind: existing.kind }, 'Memory item updated via tool');
    return {
      content: `Updated memory (ID: ${existing.id}).\nKind: ${existing.kind}\nSubject: ${existing.subject}\nNew statement: ${trimmedStatement}`,
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, memoryId }, 'memory_update failed');
    return { content: `Error: Failed to update memory: ${msg}`, isError: true };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function inferSubjectFromStatement(statement: string): string {
  // Take first few words as a subject label
  const words = statement.split(/\s+/).slice(0, 6).join(' ');
  return words.slice(0, 80);
}
