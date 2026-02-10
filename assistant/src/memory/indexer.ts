import { desc, eq } from 'drizzle-orm';
import type { MemoryConfig } from '../config/types.js';
import { getLogger } from '../util/logger.js';
import { getMemoryCheckpoint, setMemoryCheckpoint } from './checkpoints.js';
import { getDb } from './db.js';
import { enqueueMemoryJob } from './jobs-store.js';
import { extractTextFromStoredMessageContent } from './message-content.js';
import { segmentText } from './segmenter.js';
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
  for (const segment of segments) {
    const segmentId = buildSegmentId(input.messageId, segment.segmentIndex);
    db.insert(memorySegments).values({
      id: segmentId,
      messageId: input.messageId,
      conversationId: input.conversationId,
      role: input.role,
      segmentIndex: segment.segmentIndex,
      text: segment.text,
      tokenEstimate: segment.tokenEstimate,
      createdAt: input.createdAt,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: memorySegments.id,
      set: {
        text: segment.text,
        tokenEstimate: segment.tokenEstimate,
        updatedAt: now,
      },
    }).run();
  }

  if (input.role === 'user') {
    enqueueMemoryJob('extract_items', { messageId: input.messageId });
  }
  enqueueMemoryJob('build_conversation_summary', { conversationId: input.conversationId });
  enqueueSummaryRollupJobsIfDue();

  const enqueuedJobs = input.role === 'user' ? 2 : 1;
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
