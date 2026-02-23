import { createHash } from 'crypto';
import { desc, eq } from 'drizzle-orm';
import type { MemoryConfig } from '../config/types.js';
import { getLogger } from '../util/logger.js';
import { getMemoryCheckpoint, setMemoryCheckpoint } from './checkpoints.js';
import { getDb } from './db.js';
import { enqueueMemoryJob, enqueueResolvePendingConflictsForMessageJob } from './jobs-store.js';
import { extractTextFromStoredMessageContent } from './message-content.js';
import { segmentText } from './segmenter.js';
import { bumpMemoryVersion } from './recall-cache.js';
import { memorySegments } from './schema.js';

const log = getLogger('memory-indexer');
const SUMMARY_JOB_CHECKPOINT_KEY = 'memory:summary_jobs:last_scheduled_at';
const SUMMARY_SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface IndexMessageInput {
  messageId: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
  scopeId?: string;
}

export interface IndexMessageResult {
  indexedSegments: number;
  enqueuedJobs: number;
}

export function indexMessageNow(
  input: IndexMessageInput,
  config: MemoryConfig,
): IndexMessageResult {
  if (!config.enabled) return { indexedSegments: 0, enqueuedJobs: 0 };

  const text = extractTextFromStoredMessageContent(input.content);
  if (text.length === 0) {
    enqueueMemoryJob('build_conversation_summary', { conversationId: input.conversationId });
    return { indexedSegments: 0, enqueuedJobs: 1 };
  }

  const db = getDb();
  const now = Date.now();
  const segments = segmentText(
    text,
    config.segmentation.targetTokens,
    config.segmentation.overlapTokens,
  );
  const shouldExtract =
    input.role === 'user' ||
    (input.role === 'assistant' && config.extraction.extractFromAssistant);
  const shouldResolveConflicts = input.role === 'user' && config.conflicts.enabled;

  // Wrap all segment inserts and job enqueues in a single transaction so they
  // either all succeed or all roll back, preventing partial/orphaned state.
  let skippedEmbedJobs = 0;
  db.transaction((tx) => {
    for (const segment of segments) {
      const segmentId = buildSegmentId(input.messageId, segment.segmentIndex);
      const hash = createHash('sha256').update(segment.text).digest('hex');

      // Check if this segment already exists with the same content hash
      const existing = tx.select({ contentHash: memorySegments.contentHash })
        .from(memorySegments)
        .where(eq(memorySegments.id, segmentId))
        .get();

      tx.insert(memorySegments).values({
        id: segmentId,
        messageId: input.messageId,
        conversationId: input.conversationId,
        role: input.role,
        segmentIndex: segment.segmentIndex,
        text: segment.text,
        tokenEstimate: segment.tokenEstimate,
        scopeId: input.scopeId ?? 'default',
        contentHash: hash,
        createdAt: input.createdAt,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: memorySegments.id,
        set: {
          text: segment.text,
          tokenEstimate: segment.tokenEstimate,
          scopeId: input.scopeId ?? 'default',
          contentHash: hash,
          updatedAt: now,
        },
      }).run();

      if (existing?.contentHash === hash) {
        skippedEmbedJobs++;
      } else {
        enqueueMemoryJob('embed_segment', { segmentId }, Date.now(), tx);
      }
    }

    if (shouldExtract) {
      enqueueMemoryJob('extract_items', { messageId: input.messageId, scopeId: input.scopeId ?? 'default' }, Date.now(), tx);
    }
    if (shouldResolveConflicts) {
      enqueueResolvePendingConflictsForMessageJob(input.messageId, input.scopeId ?? 'default', tx);
    }
    enqueueMemoryJob('build_conversation_summary', { conversationId: input.conversationId }, Date.now(), tx);
  });

  if (skippedEmbedJobs > 0) {
    log.debug(`Skipped ${skippedEmbedJobs}/${segments.length} embed_segment jobs (content unchanged)`);
  }

  bumpMemoryVersion();
  enqueueSummaryRollupJobsIfDue();

  const enqueuedJobs = (segments.length - skippedEmbedJobs) + (shouldExtract ? 2 : 1) + (shouldResolveConflicts ? 1 : 0);
  return {
    indexedSegments: segments.length,
    enqueuedJobs,
  };
}

export function enqueueBackfillJob(force = false): string {
  return enqueueMemoryJob('backfill', { force });
}

export function enqueueRebuildIndexJob(): string {
  return enqueueMemoryJob('rebuild_index', {});
}

export function getRecentSegmentsForConversation(
  conversationId: string,
  limit: number,
): Array<typeof memorySegments.$inferSelect> {
  const db = getDb();
  return db
    .select()
    .from(memorySegments)
    .where(eq(memorySegments.conversationId, conversationId))
    .orderBy(desc(memorySegments.createdAt))
    .limit(limit)
    .all();
}

function enqueueSummaryRollupJobsIfDue(): void {
  const now = Date.now();
  const raw = getMemoryCheckpoint(SUMMARY_JOB_CHECKPOINT_KEY);
  const last = raw ? Number.parseInt(raw, 10) : 0;
  if (Number.isFinite(last) && now - last < SUMMARY_SCHEDULE_INTERVAL_MS) return;

  enqueueMemoryJob('refresh_weekly_summary', {});
  enqueueMemoryJob('refresh_monthly_summary', {});
  setMemoryCheckpoint(SUMMARY_JOB_CHECKPOINT_KEY, String(now));
  log.debug('Scheduled periodic global summary jobs');
}

function buildSegmentId(messageId: string, segmentIndex: number): string {
  return `${messageId}:${segmentIndex}`;
}
