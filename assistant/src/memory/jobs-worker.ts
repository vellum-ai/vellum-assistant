import Anthropic from '@anthropic-ai/sdk';
import { and, asc, desc, eq, gt, gte, isNull, lt, or } from 'drizzle-orm';
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
import { extractEntitiesWithLLM, upsertEntity, linkMemoryItemToEntity } from './entity-extractor.js';
import { indexMessageNow } from './indexer.js';
import { checkContradictions } from './contradiction-checker.js';
import { extractAndUpsertMemoryItemsForMessage } from './items-extractor.js';
import { extractTextFromStoredMessageContent } from './message-content.js';
import { getQdrantClient } from './qdrant-client.js';
import {
  memoryEmbeddings,
  memoryItems,
  memoryItemSources,
  memorySegments,
  memorySummaries,
  messages,
} from './schema.js';

const log = getLogger('memory-jobs-worker');
const BACKFILL_CHECKPOINT_KEY = 'memory:backfill:last_created_at';
const BACKFILL_CHECKPOINT_ID_KEY = 'memory:backfill:last_message_id';

const SUMMARY_LLM_TIMEOUT_MS = 20_000;
const SUMMARY_MAX_TOKENS = 800;

const CONVERSATION_SUMMARY_SYSTEM_PROMPT = [
  'You are a memory summarization system. Your job is to produce a compact, information-dense summary of a conversation.',
  '',
  'Guidelines:',
  '- Focus on key facts, decisions, user preferences, and actionable information.',
  '- Preserve concrete details: names, file paths, tool choices, technical decisions, constraints.',
  '- Remove filler, pleasantries, and transient discussion that has no lasting value.',
  '- Use concise bullet points grouped by topic.',
  '- Target 400-600 tokens. Be dense but readable.',
  '- If updating an existing summary with new data, merge new information and remove anything that was superseded.',
].join('\n');

const GLOBAL_SUMMARY_SYSTEM_PROMPT = [
  'You are a memory summarization system. Your job is to synthesize a higher-level summary from multiple conversation summaries and memory items.',
  '',
  'Guidelines:',
  '- Identify recurring themes, cross-cutting decisions, and persistent user preferences.',
  '- Highlight the most important facts, active projects, and ongoing concerns.',
  '- De-duplicate information that appears across multiple conversations.',
  '- Use concise sections with bullet points.',
  '- Target 400-600 tokens. Be dense but readable.',
  '- If updating an existing summary with new data, merge new information and remove anything that was superseded.',
].join('\n');

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
      await extractItemsJob(job);
      return;
    case 'extract_entities':
      await extractEntitiesJob(job, config);
      return;
    case 'check_contradictions':
      await checkContradictionsJob(job);
      return;
    case 'build_conversation_summary':
      await buildConversationSummaryJob(job, config);
      return;
    case 'refresh_weekly_summary':
      await buildGlobalSummaryJob('weekly_global', config);
      return;
    case 'refresh_monthly_summary':
      await buildGlobalSummaryJob('monthly_global', config);
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
    .select()
    .from(memorySegments)
    .where(eq(memorySegments.id, segmentId))
    .get();
  if (!segment) return;
  await embedAndUpsert(config, 'segment', segment.id, segment.text, {
    conversation_id: segment.conversationId,
    message_id: segment.messageId,
    created_at: segment.createdAt,
  });
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
  await embedAndUpsert(config, 'item', item.id, text, {
    kind: item.kind,
    subject: item.subject,
    status: item.status,
    confidence: item.confidence,
    created_at: item.firstSeenAt,
    last_seen_at: item.lastSeenAt,
  });
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
  await embedAndUpsert(config, 'summary', summary.id, `[${summary.scope}] ${summary.summary}`, {
    kind: summary.scope,
    created_at: summary.startAt,
    last_seen_at: summary.endAt,
  });
}

async function extractItemsJob(job: MemoryJob): Promise<void> {
  const messageId = asString(job.payload.messageId);
  if (!messageId) return;
  await extractAndUpsertMemoryItemsForMessage(messageId);
  // Queue entity extraction for this message after items are extracted
  const config = getConfig();
  if (config.memory.entity.enabled) {
    enqueueMemoryJob('extract_entities', { messageId });
  }
}

async function extractEntitiesJob(job: MemoryJob, config: AssistantConfig): Promise<void> {
  const messageId = asString(job.payload.messageId);
  if (!messageId) return;

  const db = getDb();
  const message = db
    .select({
      id: messages.id,
      content: messages.content,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  if (!message) return;

  const text = extractTextFromStoredMessageContent(message.content);
  if (text.trim().length < 15) return;

  const entities = await extractEntitiesWithLLM(text, config.memory.entity);
  if (entities.length === 0) return;

  // Find all memory items linked to this message via memory_item_sources
  const linkedItems = db
    .select({ memoryItemId: memoryItemSources.memoryItemId })
    .from(memoryItemSources)
    .where(eq(memoryItemSources.messageId, messageId))
    .all();
  const itemIds = linkedItems.map((row) => row.memoryItemId);

  for (const entity of entities) {
    const entityId = upsertEntity(entity);
    // Link all memory items from this message to the entity
    for (const itemId of itemIds) {
      linkMemoryItemToEntity(itemId, entityId);
    }
  }

  log.debug({ messageId, entityCount: entities.length, linkedItems: itemIds.length }, 'Extracted entities from message');
}

async function checkContradictionsJob(job: MemoryJob): Promise<void> {
  const itemId = asString(job.payload.itemId);
  if (!itemId) return;
  await checkContradictions(itemId);
}

async function buildConversationSummaryJob(job: MemoryJob, config: AssistantConfig): Promise<void> {
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

  const existing = db
    .select()
    .from(memorySummaries)
    .where(and(
      eq(memorySummaries.scope, 'conversation'),
      eq(memorySummaries.scopeKey, conversationId),
    ))
    .get();

  // Build segment text for LLM input (chronological order)
  const segmentTexts = rows
    .slice(0, 30)
    .reverse()
    .map((row) => `[${row.role}] ${truncate(row.text, 400)}`)
    .join('\n\n');

  const summaryText = await summarizeWithLLM(
    config,
    CONVERSATION_SUMMARY_SYSTEM_PROMPT,
    existing?.summary ?? null,
    segmentTexts,
    'conversation',
  );

  const now = Date.now();
  const summaryId = existing?.id ?? uuid();
  const nextVersion = (existing?.version ?? 0) + 1;
  if (existing) {
    db.update(memorySummaries)
      .set({
        summary: summaryText,
        tokenEstimate: estimateTextTokens(summaryText),
        version: nextVersion,
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
      version: nextVersion,
      startAt: rows[rows.length - 1].createdAt,
      endAt: rows[0].createdAt,
      createdAt: now,
      updatedAt: now,
    }).run();
  }
  enqueueMemoryJob('embed_summary', { summaryId });
}

async function buildGlobalSummaryJob(scope: 'weekly_global' | 'monthly_global', config: AssistantConfig): Promise<void> {
  const db = getDb();
  const now = new Date();
  const { startMs, endMs, scopeKey } = scope === 'weekly_global'
    ? currentWeekWindow(now)
    : currentMonthWindow(now);

  // Gather active memory items from this period
  const items = db
    .select()
    .from(memoryItems)
    .where(and(
      eq(memoryItems.status, 'active'),
      isNull(memoryItems.invalidAt),
      gte(memoryItems.lastSeenAt, startMs),
      lt(memoryItems.lastSeenAt, endMs),
    ))
    .orderBy(desc(memoryItems.lastSeenAt))
    .limit(80)
    .all();

  // Gather conversation summaries from this period for higher-level synthesis
  const convSummaries = db
    .select()
    .from(memorySummaries)
    .where(and(
      eq(memorySummaries.scope, 'conversation'),
      gte(memorySummaries.endAt, startMs),
      lt(memorySummaries.startAt, endMs),
    ))
    .orderBy(desc(memorySummaries.endAt))
    .limit(20)
    .all();

  if (items.length === 0 && convSummaries.length === 0) return;

  // Build input for LLM: conversation summaries + active items
  const parts: string[] = [];
  if (convSummaries.length > 0) {
    parts.push('## Conversation Summaries');
    for (const cs of convSummaries) {
      parts.push(`### ${cs.scopeKey}\n${truncate(cs.summary, 600)}`);
    }
  }
  if (items.length > 0) {
    parts.push('## Active Memory Items');
    for (const item of items.slice(0, 40)) {
      parts.push(`- [${item.kind}] ${item.subject}: ${truncate(item.statement, 180)}`);
    }
  }
  const inputText = parts.join('\n\n');

  const existing = db
    .select()
    .from(memorySummaries)
    .where(and(
      eq(memorySummaries.scope, scope),
      eq(memorySummaries.scopeKey, scopeKey),
    ))
    .get();

  const label = scope === 'weekly_global' ? 'weekly' : 'monthly';
  const summaryText = await summarizeWithLLM(
    config,
    GLOBAL_SUMMARY_SYSTEM_PROMPT,
    existing?.summary ?? null,
    inputText,
    label,
  );

  const ts = Date.now();
  const summaryId = existing?.id ?? uuid();
  const nextVersion = (existing?.version ?? 0) + 1;
  if (existing) {
    db.update(memorySummaries)
      .set({
        summary: summaryText,
        tokenEstimate: estimateTextTokens(summaryText),
        version: nextVersion,
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
      version: nextVersion,
      startAt: startMs,
      endAt: endMs,
      createdAt: ts,
      updatedAt: ts,
    }).run();
  }
  enqueueMemoryJob('embed_summary', { summaryId });
}

async function summarizeWithLLM(
  config: AssistantConfig,
  systemPrompt: string,
  existingSummary: string | null,
  newContent: string,
  label: string,
): Promise<string> {
  const summarizationConfig = config.memory.summarization;
  if (!summarizationConfig.useLLM) {
    log.debug({ label }, 'LLM summarization disabled, using fallback');
    return buildFallbackSummary(existingSummary, newContent, label);
  }

  const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log.debug({ label }, 'No Anthropic API key available for summarization, using fallback');
    return buildFallbackSummary(existingSummary, newContent, label);
  }

  const userParts: string[] = [];
  if (existingSummary) {
    userParts.push(
      '### Existing Summary (update with new data, keep what is still relevant, remove superseded info)',
      existingSummary,
      '',
    );
  }
  userParts.push('### New Data', newContent);

  try {
    const client = new Anthropic({ apiKey });
    const response = await Promise.race([
      client.messages.create({
        model: summarizationConfig.model,
        max_tokens: SUMMARY_MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user' as const, content: userParts.join('\n') }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Summarization LLM timeout')), SUMMARY_LLM_TIMEOUT_MS),
      ),
    ]);

    const textBlock = response.content.find((b) => b.type === 'text');
    if (textBlock && textBlock.type === 'text' && textBlock.text.trim().length > 0) {
      log.debug(
        { label, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
        'LLM summarization completed',
      );
      return textBlock.text.trim();
    }

    log.warn({ label }, 'LLM summarization returned empty text, using fallback');
    return buildFallbackSummary(existingSummary, newContent, label);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message, label }, 'LLM summarization failed, using fallback');
    return buildFallbackSummary(existingSummary, newContent, label);
  }
}

function buildFallbackSummary(_existingSummary: string | null, newContent: string, label: string): string {
  const lines = newContent.split('\n').filter((l) => l.trim().length > 0);
  const snippets = lines.slice(0, 20).map((l) => `- ${truncate(l.trim(), 180)}`);
  const parts: string[] = [`${label} summary`, '', ...snippets];
  return parts.join('\n');
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

  const segments = db.select({ id: memorySegments.id }).from(memorySegments).all();
  for (const segment of segments) {
    enqueueMemoryJob('embed_segment', { segmentId: segment.id });
  }
}

async function embedAndUpsert(
  config: AssistantConfig,
  targetType: 'segment' | 'item' | 'summary',
  targetId: string,
  text: string,
  extraPayload?: Record<string, unknown>,
): Promise<void> {
  const status = getMemoryBackendStatus(config);
  if (!status.provider) {
    log.debug(
      { targetType, targetId, reason: status.reason ?? 'backend unavailable' },
      'Skipping embedding job because no backend is configured',
    );
    return;
  }

  const embedded = await embedWithBackend(config, [text]);
  const vector = embedded.vectors[0];
  if (!vector) return;

  try {
    const qdrant = getQdrantClient();
    const now = Date.now();
    await qdrant.upsert(targetType, targetId, vector, {
      text,
      created_at: (extraPayload?.created_at as number) ?? now,
      ...(extraPayload as Record<string, unknown> | undefined),
    });
  } catch (err) {
    log.warn({ err, targetType, targetId }, 'Failed to upsert embedding to Qdrant');
    throw err;
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

export function currentWeekWindow(now: Date): { scopeKey: string; startMs: number; endMs: number } {
  const day = (now.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - day,
    0,
    0,
    0,
    0,
  ));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
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
