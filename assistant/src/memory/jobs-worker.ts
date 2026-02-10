import { and, asc, desc, eq, gt, gte, lt, or } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { AssistantConfig } from '../config/types.js';
import { getConfig } from '../config/loader.js';
import { estimateTextTokens } from '../context/token-estimator.js';
import { getLogger } from '../util/logger.js';
import { getMemoryCheckpoint, setMemoryCheckpoint } from './checkpoints.js';
import { embedWithBackend, getMemoryBackendStatus } from './embedding-backend.js';
import { getDb } from './db.js';
import {
  claimMemoryJobs,
  completeMemoryJob,
  enqueueMemoryJob,
  failMemoryJob,
  type MemoryJob,
  resetRunningJobsToPending,
} from './jobs-store.js';
import { indexMessageNow } from './indexer.js';
import { extractAndUpsertMemoryItemsForMessage } from './items-extractor.js';
import { memoryEmbeddings, memoryItems, memorySegments, memorySummaries, messages } from './schema.js';

const log = getLogger('memory-jobs-worker');
const BACKFILL_CHECKPOINT_KEY = 'memory:backfill:last_created_at';
const BACKFILL_CHECKPOINT_ID_KEY = 'memory:backfill:last_message_id';

export interface MemoryJobsWorker {
  runOnce(): Promise<number>;
  stop(): void;
}

export function startMemoryJobsWorker(): MemoryJobsWorker {
  const recovered = resetRunningJobsToPending();
  if (recovered > 0) {
    log.info({ recovered }, 'Recovered stale running memory jobs');
  }

  let stopped = false;
  let tickRunning = false;

  const tick = async () => {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try {
      await runMemoryJobsOnce();
    } catch (err) {
      log.error({ err }, 'Memory worker tick failed');
    } finally {
      tickRunning = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, 1500);
  timer.unref();
  void tick();

  return {
    async runOnce(): Promise<number> {
      return runMemoryJobsOnce();
    },
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export async function runMemoryJobsOnce(): Promise<number> {
  const config = getConfig();
  if (!config.memory.enabled) return 0;
  const concurrency = Math.max(1, config.memory.jobs.workerConcurrency);
  const jobs = claimMemoryJobs(concurrency);
  if (jobs.length === 0) return 0;

  let processed = 0;
  for (const job of jobs) {
    try {
      await processJob(job, config);
      completeMemoryJob(job.id);
      processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failMemoryJob(job.id, message);
      log.warn({ err, jobId: job.id, type: job.type }, 'Memory job failed');
    }
  }
  return processed;
}

async function processJob(job: MemoryJob, config: AssistantConfig): Promise<void> {
  switch (job.type) {
    case 'embed_segment':
      await embedSegmentJob(job, config);
      return;
    case 'embed_item':
      await embedItemJob(job, config);
      return;
    case 'embed_summary':
      await embedSummaryJob(job, config);
      return;
    case 'extract_items':
      extractItemsJob(job);
      return;
    case 'build_conversation_summary':
      buildConversationSummaryJob(job);
      return;
    case 'refresh_weekly_summary':
      buildGlobalSummaryJob('weekly_global');
      return;
    case 'refresh_monthly_summary':
      buildGlobalSummaryJob('monthly_global');
      return;
    case 'backfill':
      backfillJob(job, config);
      return;
    case 'rebuild_index':
      rebuildIndexJob();
      return;
    default:
      throw new Error(`Unknown memory job type: ${(job as { type: string }).type}`);
  }
}

async function embedSegmentJob(job: MemoryJob, config: AssistantConfig): Promise<void> {
  const segmentId = asString(job.payload.segmentId);
  if (!segmentId) return;
  const db = getDb();
  const segment = db
    .select({ id: memorySegments.id, text: memorySegments.text })
    .from(memorySegments)
    .where(eq(memorySegments.id, segmentId))
    .get();
  if (!segment) return;
  await embedAndUpsert(config, 'segment', segment.id, segment.text);
}

async function embedItemJob(job: MemoryJob, config: AssistantConfig): Promise<void> {
  const itemId = asString(job.payload.itemId);
  if (!itemId) return;
  const db = getDb();
  const item = db
    .select()
    .from(memoryItems)
    .where(eq(memoryItems.id, itemId))
    .get();
  if (!item || item.status !== 'active') return;
  const text = `[${item.kind}] ${item.subject}: ${item.statement}`;
  await embedAndUpsert(config, 'item', item.id, text);
}

async function embedSummaryJob(job: MemoryJob, config: AssistantConfig): Promise<void> {
  const summaryId = asString(job.payload.summaryId);
  if (!summaryId) return;
  const db = getDb();
  const summary = db
    .select()
    .from(memorySummaries)
    .where(eq(memorySummaries.id, summaryId))
    .get();
  if (!summary) return;
  await embedAndUpsert(config, 'summary', summary.id, `[${summary.scope}] ${summary.summary}`);
}

function extractItemsJob(job: MemoryJob): void {
  const messageId = asString(job.payload.messageId);
  if (!messageId) return;
  extractAndUpsertMemoryItemsForMessage(messageId);
}

function buildConversationSummaryJob(job: MemoryJob): void {
  const conversationId = asString(job.payload.conversationId);
  if (!conversationId) return;
  const db = getDb();
  const rows = db
    .select()
    .from(memorySegments)
    .where(eq(memorySegments.conversationId, conversationId))
    .orderBy(desc(memorySegments.createdAt))
    .limit(40)
    .all();
  if (rows.length === 0) return;
  const snippets = rows
    .slice(0, 20)
    .map((row) => `- ${truncate(row.text, 180)}`);
  const summaryText = [
    `Conversation ${conversationId}`,
    '',
    ...snippets,
  ].join('\n');
  const now = Date.now();
  const existing = db
    .select()
    .from(memorySummaries)
    .where(and(
      eq(memorySummaries.scope, 'conversation'),
      eq(memorySummaries.scopeKey, conversationId),
    ))
    .get();
  const summaryId = existing?.id ?? uuid();
  if (existing) {
    db.update(memorySummaries)
      .set({
        summary: summaryText,
        tokenEstimate: estimateTextTokens(summaryText),
        startAt: rows[rows.length - 1].createdAt,
        endAt: rows[0].createdAt,
        updatedAt: now,
      })
      .where(eq(memorySummaries.id, existing.id))
      .run();
  } else {
    db.insert(memorySummaries).values({
      id: summaryId,
      scope: 'conversation',
      scopeKey: conversationId,
      summary: summaryText,
      tokenEstimate: estimateTextTokens(summaryText),
      startAt: rows[rows.length - 1].createdAt,
      endAt: rows[0].createdAt,
      createdAt: now,
      updatedAt: now,
    }).run();
  }
  enqueueMemoryJob('embed_summary', { summaryId });
}

function buildGlobalSummaryJob(scope: 'weekly_global' | 'monthly_global'): void {
  const db = getDb();
  const now = new Date();
  const { startMs, endMs, scopeKey } = scope === 'weekly_global'
    ? currentWeekWindow(now)
    : currentMonthWindow(now);

  const items = db
    .select()
    .from(memoryItems)
    .where(and(
      eq(memoryItems.status, 'active'),
      gte(memoryItems.lastSeenAt, startMs),
      lt(memoryItems.lastSeenAt, endMs),
    ))
    .orderBy(desc(memoryItems.lastSeenAt))
    .limit(80)
    .all();

  if (items.length === 0) return;
  const lines = items.slice(0, 40).map((item) => `- [${item.kind}] ${item.subject}: ${truncate(item.statement, 180)}`);
  const summaryText = [
    scope === 'weekly_global' ? `Weekly memory summary (${scopeKey})` : `Monthly memory summary (${scopeKey})`,
    '',
    ...lines,
  ].join('\n');

  const existing = db
    .select()
    .from(memorySummaries)
    .where(and(
      eq(memorySummaries.scope, scope),
      eq(memorySummaries.scopeKey, scopeKey),
    ))
    .get();

  const ts = Date.now();
  const summaryId = existing?.id ?? uuid();
  if (existing) {
    db.update(memorySummaries)
      .set({
        summary: summaryText,
        tokenEstimate: estimateTextTokens(summaryText),
        startAt: startMs,
        endAt: endMs,
        updatedAt: ts,
      })
      .where(eq(memorySummaries.id, existing.id))
      .run();
  } else {
    db.insert(memorySummaries).values({
      id: summaryId,
      scope,
      scopeKey,
      summary: summaryText,
      tokenEstimate: estimateTextTokens(summaryText),
      startAt: startMs,
      endAt: endMs,
      createdAt: ts,
      updatedAt: ts,
    }).run();
  }
  enqueueMemoryJob('embed_summary', { summaryId });
}

function backfillJob(job: MemoryJob, config: AssistantConfig): void {
  const db = getDb();
  const force = job.payload.force === true;
  if (force) {
    setMemoryCheckpoint(BACKFILL_CHECKPOINT_KEY, '0');
    setMemoryCheckpoint(BACKFILL_CHECKPOINT_ID_KEY, '');
  }

  const lastCreatedAt = Number.parseInt(getMemoryCheckpoint(BACKFILL_CHECKPOINT_KEY) ?? '0', 10) || 0;
  const lastMessageId = getMemoryCheckpoint(BACKFILL_CHECKPOINT_ID_KEY) ?? '';
  const batch = db
    .select()
    .from(messages)
    .where(or(
      gt(messages.createdAt, lastCreatedAt),
      and(eq(messages.createdAt, lastCreatedAt), gt(messages.id, lastMessageId)),
    ))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(200)
    .all();
  if (batch.length === 0) return;
  for (const message of batch) {
    indexMessageNow({
      messageId: message.id,
      conversationId: message.conversationId,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    }, config.memory);
  }
  const lastMessage = batch[batch.length - 1];
  setMemoryCheckpoint(BACKFILL_CHECKPOINT_KEY, String(lastMessage.createdAt));
  setMemoryCheckpoint(BACKFILL_CHECKPOINT_ID_KEY, lastMessage.id);
  if (batch.length === 200) {
    enqueueMemoryJob('backfill', {});
  }
}

function rebuildIndexJob(): void {
  const db = getDb();
  db.run(/*sql*/ `DELETE FROM memory_segment_fts`);
  db.run(/*sql*/ `
    INSERT INTO memory_segment_fts(segment_id, text)
    SELECT id, text FROM memory_segments
  `);
  db.delete(memoryEmbeddings).run();

  const segments = db.select({ id: memorySegments.id }).from(memorySegments).all();
  for (const segment of segments) {
    enqueueMemoryJob('embed_segment', { segmentId: segment.id });
  }

  const items = db
    .select({ id: memoryItems.id })
    .from(memoryItems)
    .where(eq(memoryItems.status, 'active'))
    .all();
  for (const item of items) {
    enqueueMemoryJob('embed_item', { itemId: item.id });
  }

  const summaries = db.select({ id: memorySummaries.id }).from(memorySummaries).all();
  for (const summary of summaries) {
    enqueueMemoryJob('embed_summary', { summaryId: summary.id });
  }
}

async function embedAndUpsert(
  config: AssistantConfig,
  targetType: 'segment' | 'item' | 'summary',
  targetId: string,
  text: string,
): Promise<void> {
  const status = getMemoryBackendStatus(config);
  if (!status.provider) {
    if (config.memory.embeddings.required) {
      throw new Error(status.reason ?? 'Memory embeddings backend unavailable');
    }
    return;
  }

  const embedded = await embedWithBackend(config, [text]);
  const vector = embedded.vectors[0];
  if (!vector) return;

  const db = getDb();
  const now = Date.now();
  const existing = db
    .select()
    .from(memoryEmbeddings)
    .where(and(
      eq(memoryEmbeddings.targetType, targetType),
      eq(memoryEmbeddings.targetId, targetId),
      eq(memoryEmbeddings.provider, embedded.provider),
      eq(memoryEmbeddings.model, embedded.model),
    ))
    .get();

  if (existing) {
    db.update(memoryEmbeddings)
      .set({
        dimensions: vector.length,
        vectorJson: JSON.stringify(vector),
        updatedAt: now,
      })
      .where(eq(memoryEmbeddings.id, existing.id))
      .run();
    return;
  }

  db.insert(memoryEmbeddings).values({
    id: uuid(),
    targetType,
    targetId,
    provider: embedded.provider,
    model: embedded.model,
    dimensions: vector.length,
    vectorJson: JSON.stringify(vector),
    createdAt: now,
    updatedAt: now,
  }).run();
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function currentWeekWindow(now: Date): { scopeKey: string; startMs: number; endMs: number } {
  const start = new Date(now);
  const day = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const scopeKey = `${start.getUTCFullYear()}-W${weekNumber(start).toString().padStart(2, '0')}`;
  return { scopeKey, startMs: start.getTime(), endMs: end.getTime() };
}

function currentMonthWindow(now: Date): { scopeKey: string; startMs: number; endMs: number } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  const scopeKey = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  return { scopeKey, startMs: start.getTime(), endMs: end.getTime() };
}

function weekNumber(date: Date): number {
  const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}
