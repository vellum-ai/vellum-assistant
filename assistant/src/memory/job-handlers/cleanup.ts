import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import type { AssistantConfig } from '../../config/types.js';
import { getLogger } from '../../util/logger.js';
import { getDb, rawAll } from '../db.js';
import { checkContradictions } from '../contradiction-checker.js';
import { enqueueMemoryJob, type MemoryJob } from '../jobs-store.js';
import { asPositiveMs, asString } from '../job-utils.js';
import { memoryEmbeddings, memoryItemEntities, memoryItems } from '../schema.js';
import { deleteConversation } from '../conversation-store.js';

const log = getLogger('memory-jobs-worker');

const CLEANUP_BATCH_LIMIT = 250;

export async function checkContradictionsJob(job: MemoryJob): Promise<void> {
  const itemId = asString(job.payload.itemId);
  if (!itemId) return;
  await checkContradictions(itemId);
}

export function cleanupStaleSupersededItemsJob(job: MemoryJob, config: AssistantConfig): void {
  const db = getDb();
  const retentionMs = asPositiveMs(job.payload.retentionMs) ?? config.memory.cleanup.supersededItemRetentionMs;
  const cutoff = Date.now() - retentionMs;
  const stale = db
    .select({ id: memoryItems.id })
    .from(memoryItems)
    .where(and(
      eq(memoryItems.status, 'superseded'),
      lt(memoryItems.invalidAt, cutoff),
    ))
    .orderBy(asc(memoryItems.invalidAt), asc(memoryItems.id))
    .limit(CLEANUP_BATCH_LIMIT)
    .all();
  if (stale.length === 0) return;

  const ids = stale.map((row) => row.id);
  db.delete(memoryItemEntities)
    .where(inArray(memoryItemEntities.memoryItemId, ids))
    .run();
  db.delete(memoryEmbeddings)
    .where(and(
      eq(memoryEmbeddings.targetType, 'item'),
      inArray(memoryEmbeddings.targetId, ids),
    ))
    .run();
  db.delete(memoryItems)
    .where(inArray(memoryItems.id, ids))
    .run();
  if (stale.length === CLEANUP_BATCH_LIMIT) {
    enqueueMemoryJob('cleanup_stale_superseded_items', { retentionMs });
  }

  log.debug({
    removedItems: stale.length,
    retentionMs,
    cutoff,
  }, 'Cleaned up stale superseded memory items');
}

export function pruneOldConversationsJob(job: MemoryJob, config: AssistantConfig): void {
  const pruningConfig = config.memory.cleanup.conversationPruning;
  if (!pruningConfig.enabled) return;

  const retentionDays = (typeof job.payload.retentionDays === 'number' && job.payload.retentionDays > 0)
    ? job.payload.retentionDays
    : pruningConfig.retentionDays;
  const batchSize = (typeof job.payload.batchSize === 'number' && job.payload.batchSize > 0)
    ? job.payload.batchSize
    : pruningConfig.batchSize;

  const cutoffMs = Date.now() - retentionDays * 86_400_000;

  // Find conversations with no activity since the cutoff.
  // updatedAt is bumped on every message, so it reflects last activity.
  const stale = rawAll<{ id: string }>(
    `SELECT id FROM conversations WHERE updated_at < ? ORDER BY updated_at ASC LIMIT ?`,
    cutoffMs, batchSize,
  );
  if (stale.length === 0) return;

  for (const { id } of stale) {
    deleteConversation(id);
  }

  log.info({
    pruned: stale.length,
    retentionDays,
    cutoffMs,
  }, 'Pruned old conversations');

  // If we hit the batch limit, re-enqueue to continue in the next tick
  if (stale.length >= batchSize) {
    enqueueMemoryJob('prune_old_conversations', { retentionDays, batchSize });
  }
}
