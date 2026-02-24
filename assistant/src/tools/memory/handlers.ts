import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { AssistantConfig } from '../../config/types.js';
import { getLogger } from '../../util/logger.js';
import { truncate } from '../../util/truncate.js';
import { getDb } from '../../memory/db.js';
import { computeMemoryFingerprint } from '../../memory/fingerprint.js';
import { memoryItems } from '../../memory/schema.js';
import { enqueueMemoryJob } from '../../memory/jobs-store.js';
import { searchMemoryItems, formatRelativeTime } from '../../memory/retriever.js';
import type { ScopePolicyOverride } from '../../memory/search/types.js';
import type { ToolExecutionResult } from '../types.js';

const log = getLogger('memory-tools');

// ── memory_search ────────────────────────────────────────────────────

export async function handleMemorySearch(
  args: Record<string, unknown>,
  config: AssistantConfig,
  scopeId?: string,
): Promise<ToolExecutionResult> {
  const query = args.query;
  if (typeof query !== 'string' || query.trim().length === 0) {
    return { content: 'Error: query is required and must be a non-empty string', isError: true };
  }

  const limit = typeof args.limit === 'number' && args.limit > 0
    ? Math.min(args.limit, 20)
    : 5;

  // Private threads should always fall back to default scope for search
  const scopePolicyOverride: ScopePolicyOverride | undefined =
    scopeId && scopeId.startsWith('private:')
      ? { scopeId, fallbackToDefault: true }
      : undefined;

  try {
    const results = await searchMemoryItems(query, limit, config, scopeId, scopePolicyOverride);

    if (results.length === 0) {
      return { content: 'No matching memories found.', isError: false };
    }

    const lines: string[] = [`Found ${results.length} memory item(s):\n`];
    for (const result of results) {
      const timeAgo = formatRelativeTime(result.createdAt);
      lines.push(`- **[${result.kind}]** ${result.text}`);
      lines.push(`  _ID: ${result.id} | source: ${result.type} | ${timeAgo} | confidence: ${result.confidence.toFixed(2)} | importance: ${result.importance.toFixed(2)}_`);
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
  scopeId: string = 'default',
): Promise<ToolExecutionResult> {
  const statement = args.statement;
  if (typeof statement !== 'string' || statement.trim().length === 0) {
    return { content: 'Error: statement is required and must be a non-empty string', isError: true };
  }

  const kind = args.kind;
  const validKinds = new Set([
    'preference', 'fact', 'decision', 'profile',
    'relationship', 'event', 'opinion', 'instruction', 'style',
    'playbook', 'learning',
  ]);
  if (typeof kind !== 'string' || !validKinds.has(kind)) {
    return {
      content: `Error: kind is required and must be one of: ${[...validKinds].join(', ')}`,
      isError: true,
    };
  }

  const subject = typeof args.subject === 'string' && args.subject.trim().length > 0
    ? truncate(args.subject.trim(), 80, '')
    : inferSubjectFromStatement(statement.trim());

  try {
    const db = getDb();
    const id = uuid();
    const now = Date.now();
    const trimmedStatement = truncate(statement.trim(), 500, '');

    const fingerprint = computeMemoryFingerprint(scopeId, kind, subject, trimmedStatement);

    const existing = db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.fingerprint, fingerprint), eq(memoryItems.scopeId, scopeId)))
      .get();

    if (existing) {
      db.update(memoryItems)
        .set({
          status: 'active',
          importance: 0.8,
          lastSeenAt: now,
          verificationState: 'user_confirmed',
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
      verificationState: 'user_confirmed',
      scopeId,
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
  scopeId: string = 'default',
): Promise<ToolExecutionResult> {
  const rawMemoryId = args.memory_id;
  if (typeof rawMemoryId !== 'string' || rawMemoryId.trim().length === 0) {
    return { content: 'Error: memory_id is required and must be a non-empty string', isError: true };
  }

  // Accept both bare IDs and typed IDs (e.g. "item:abc-123" -> "abc-123")
  const memoryId = stripTypedIdPrefix(rawMemoryId.trim());

  const statement = args.statement;
  if (typeof statement !== 'string' || statement.trim().length === 0) {
    return { content: 'Error: statement is required and must be a non-empty string', isError: true };
  }

  try {
    const db = getDb();

    // Constrain lookup to the current scope so threads cannot mutate
    // memory items belonging to a different scope.
    const existing = db
      .select()
      .from(memoryItems)
      .where(and(eq(memoryItems.id, memoryId), eq(memoryItems.scopeId, scopeId)))
      .get();

    if (!existing) {
      return { content: `Error: Memory item with ID "${memoryId}" not found`, isError: true };
    }

    const now = Date.now();
    const trimmedStatement = truncate(statement.trim(), 500, '');

    const fingerprint = computeMemoryFingerprint(scopeId, existing.kind, existing.subject, trimmedStatement);

    // Collision detection also constrained to the current scope.
    const collision = db
      .select({ id: memoryItems.id })
      .from(memoryItems)
      .where(and(eq(memoryItems.fingerprint, fingerprint), eq(memoryItems.scopeId, scopeId)))
      .get();
    if (collision && collision.id !== existing.id) {
      return {
        content: `Error: Another memory item (ID: ${collision.id}) already contains this statement. Use memory_search to find it.`,
        isError: true,
      };
    }

    db.update(memoryItems)
      .set({
        statement: trimmedStatement,
        fingerprint,
        lastSeenAt: now,
        importance: 0.8,
        verificationState: 'user_confirmed',
      })
      .where(eq(memoryItems.id, existing.id))
      .run();

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
  return truncate(words, 80, '');
}

/**
 * Strip a typed ID prefix (e.g. "item:abc-123" -> "abc-123") so that IDs
 * copied from memory_search output work in memory_update.
 */
function stripTypedIdPrefix(id: string): string {
  const match = id.match(/^(?:item|segment|summary):(.+)$/);
  return match ? match[1] : id;
}
