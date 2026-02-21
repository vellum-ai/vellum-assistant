import { and, asc, eq, inArray, lt, ne } from 'drizzle-orm';
import type { AssistantConfig } from '../../config/types.js';
import { getLogger } from '../../util/logger.js';
import {
  computeConflictRelevance,
  looksLikeClarificationReply,
  shouldAttemptConflictResolution,
} from '../conflict-intent.js';
import { isConflictKindPairEligible, isStatementConflictEligible } from '../conflict-policy.js';
import { getDb } from '../db.js';
import { resolveConflictClarification } from '../clarification-resolver.js';
import { applyConflictResolution, listPendingConflictDetails, resolveConflict } from '../conflict-store.js';
import { enqueueMemoryJob, type MemoryJob } from '../jobs-store.js';
import { asPositiveMs, asString } from '../job-utils.js';
import { extractTextFromStoredMessageContent } from '../message-content.js';
import { memoryItemConflicts, messages } from '../schema.js';

const log = getLogger('memory-jobs-worker');

const CLEANUP_BATCH_LIMIT = 250;
const BACKGROUND_RECENT_ASK_WINDOW_MS = 6 * 60 * 60 * 1000;

export async function resolvePendingConflictsForMessageJob(job: MemoryJob, config: AssistantConfig): Promise<void> {
  if (!config.memory.conflicts.enabled) return;
  const messageId = asString(job.payload.messageId);
  if (!messageId) return;
  const scopeId = asString(job.payload.scopeId) ?? 'default';
  const db = getDb();
  const message = db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  if (!message || message.role !== 'user') return;

  const userMessage = extractTextFromStoredMessageContent(message.content).trim();
  if (userMessage.length === 0) return;
  const clarificationReply = looksLikeClarificationReply(userMessage);
  if (!clarificationReply) return;

  const pending = listPendingConflictDetails(scopeId, 25);

  // Dismiss non-actionable conflicts (kind or statement policy)
  const conflictableKinds = config.memory.conflicts.conflictableKinds;
  for (const conflict of pending) {
    const kindEligible = isConflictKindPairEligible(
      conflict.existingKind, conflict.candidateKind, { conflictableKinds },
    );
    if (!kindEligible
      || !isStatementConflictEligible(conflict.existingKind, conflict.existingStatement)
      || !isStatementConflictEligible(conflict.candidateKind, conflict.candidateStatement)) {
      resolveConflict(conflict.id, {
        status: 'dismissed',
        resolutionNote: 'Dismissed by conflict policy (transient/non-durable).',
      });
    }
  }

  // Re-fetch after dismissal
  const actionablePending = listPendingConflictDetails(scopeId, 25);
  const eligible = actionablePending.filter((conflict) => conflict.createdAt <= message.createdAt);
  if (eligible.length === 0) return;
  const candidates = eligible.filter((conflict) => {
    const askedAt = conflict.lastAskedAt;
    const wasRecentlyAsked = typeof askedAt === 'number'
      && askedAt <= message.createdAt
      && message.createdAt - askedAt <= BACKGROUND_RECENT_ASK_WINDOW_MS;
    const relevance = computeConflictRelevance(userMessage, conflict);
    return shouldAttemptConflictResolution({
      clarificationReply,
      relevance,
      wasRecentlyAsked,
    });
  });
  if (candidates.length === 0) return;

  let resolvedCount = 0;
  for (const conflict of candidates) {
    const resolution = await resolveConflictClarification(
      {
        existingStatement: conflict.existingStatement,
        candidateStatement: conflict.candidateStatement,
        userMessage,
      },
      { timeoutMs: config.memory.conflicts.resolverLlmTimeoutMs },
    );
    if (resolution.resolution === 'still_unclear') continue;
    const resolved = applyConflictResolution({
      conflictId: conflict.id,
      resolution: resolution.resolution,
      mergedStatement: resolution.resolution === 'merge' ? resolution.resolvedStatement : null,
      resolutionNote: `Background message resolver (${resolution.strategy}): ${resolution.explanation}`,
    });
    if (resolved) resolvedCount += 1;
  }

  log.debug({
    messageId,
    scopeId,
    pendingConflicts: pending.length,
    eligibleConflicts: eligible.length,
    candidateConflicts: candidates.length,
    resolvedConflicts: resolvedCount,
  }, 'Processed pending conflict resolution job');
}

export function cleanupResolvedConflictsJob(job: MemoryJob, config: AssistantConfig): void {
  const db = getDb();
  const retentionMs = asPositiveMs(job.payload.retentionMs) ?? config.memory.cleanup.resolvedConflictRetentionMs;
  const cutoff = Date.now() - retentionMs;
  const stale = db
    .select({ id: memoryItemConflicts.id })
    .from(memoryItemConflicts)
    .where(and(
      ne(memoryItemConflicts.status, 'pending_clarification'),
      lt(memoryItemConflicts.resolvedAt, cutoff),
    ))
    .orderBy(asc(memoryItemConflicts.resolvedAt), asc(memoryItemConflicts.id))
    .limit(CLEANUP_BATCH_LIMIT)
    .all();
  if (stale.length === 0) return;

  const ids = stale.map((row) => row.id);
  db.delete(memoryItemConflicts)
    .where(inArray(memoryItemConflicts.id, ids))
    .run();
  if (stale.length === CLEANUP_BATCH_LIMIT) {
    enqueueMemoryJob('cleanup_resolved_conflicts', { retentionMs });
  }

  log.debug({
    removedConflicts: stale.length,
    retentionMs,
    cutoff,
  }, 'Cleaned up resolved memory conflicts');
}
