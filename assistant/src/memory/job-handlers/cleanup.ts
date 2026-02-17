import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import type { AssistantConfig } from '../../config/types.js';
import { getLogger } from '../../util/logger.js';
import { getDb } from '../db.js';
import { checkContradictions } from '../contradiction-checker.js';
import { enqueueMemoryJob, type MemoryJob } from '../jobs-store.js';
import { asPositiveMs, asString } from '../job-utils.js';
import { memoryEmbeddings, memoryItemEntities, memoryItems } from '../schema.js';

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
