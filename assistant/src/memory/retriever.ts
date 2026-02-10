import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import type { AssistantConfig } from '../config/types.js';
import { estimateTextTokens } from '../context/token-estimator.js';
import { getLogger } from '../util/logger.js';
import { embedWithBackend, getMemoryBackendStatus, logMemoryEmbeddingWarning } from './embedding-backend.js';
import { getDb } from './db.js';
import { memoryEmbeddings, memoryItems, memorySegments, memorySummaries } from './schema.js';

const log = getLogger('memory-retriever');
const MEMORY_RECALL_MARKER = '[Memory Recall v1]';

type CandidateType = 'segment' | 'item' | 'summary';

interface Candidate {
  key: string;
  type: CandidateType;
  id: string;
  text: string;
  confidence: number;
  createdAt: number;
  lexical: number;
  semantic: number;
  recency: number;
  finalScore: number;
}

export interface MemoryRecallResult {
  enabled: boolean;
  degraded: boolean;
  reason?: string;
  provider?: string;
  model?: string;
  lexicalHits: number;
  semanticHits: number;
  recencyHits: number;
  injectedTokens: number;
  injectedText: string;
  latencyMs: number;
}

interface MemoryRecallOptions {
  excludeMessageIds?: string[];
}

export async function buildMemoryRecall(
  query: string,
  conversationId: string,
  config: AssistantConfig,
  options?: MemoryRecallOptions,
): Promise<MemoryRecallResult> {
  const start = Date.now();
  const excludeMessageIds = options?.excludeMessageIds?.filter((id) => id.length > 0) ?? [];
  if (!config.memory.enabled) {
    return emptyResult({ enabled: false, degraded: false, reason: 'memory.disabled', latencyMs: Date.now() - start });
  }

  const backendStatus = getMemoryBackendStatus(config);
  let queryVector: number[] | null = null;
  let provider: string | undefined;
  let model: string | undefined;
  let degraded = backendStatus.degraded;
  let reason = backendStatus.reason ?? undefined;

  if (backendStatus.provider) {
    try {
      const embedded = await embedWithBackend(config, [query]);
      queryVector = embedded.vectors[0] ?? null;
      provider = embedded.provider;
      model = embedded.model;
      degraded = false;
      reason = undefined;
    } catch (err) {
      logMemoryEmbeddingWarning(err, 'query');
      degraded = config.memory.embeddings.required;
      reason = `memory.embedding_failure: ${err instanceof Error ? err.message : String(err)}`;
      if (config.memory.embeddings.required) {
        return emptyResult({
          enabled: true,
          degraded,
          reason,
          provider: backendStatus.provider,
          model: backendStatus.model ?? undefined,
          latencyMs: Date.now() - start,
        });
      }
    }
  } else if (config.memory.embeddings.required) {
    return emptyResult({
      enabled: true,
      degraded: true,
      reason: reason ?? 'memory.embedding_backend_missing',
      latencyMs: Date.now() - start,
    });
  }

  let lexicalCandidates: Candidate[] = [];
  let recencyCandidates: Candidate[] = [];
  let semanticCandidates: Candidate[] = [];
  try {
    lexicalCandidates = lexicalSearch(query, config.memory.retrieval.lexicalTopK, excludeMessageIds);
    recencyCandidates = recencySearch(
      conversationId,
      Math.max(10, Math.floor(config.memory.retrieval.semanticTopK / 2)),
      excludeMessageIds,
    );
    semanticCandidates = queryVector
      ? await semanticSearch(queryVector, provider!, model!, config.memory.retrieval.semanticTopK)
      : [];
  } catch (err) {
    log.warn({ err }, 'Memory retrieval failed, returning degraded empty recall');
    return emptyResult({
      enabled: true,
      degraded: true,
      reason: `memory.retrieval_failure: ${err instanceof Error ? err.message : String(err)}`,
      provider,
      model,
      latencyMs: Date.now() - start,
    });
  }

  const merged = mergeCandidates(lexicalCandidates, semanticCandidates, recencyCandidates);
  const selected = trimToTokenBudget(merged, config.memory.retrieval.maxInjectTokens);
  markItemUsage(selected);

  const lines = selected.map((candidate) => `- [${candidate.type}:${candidate.id}] ${truncate(candidate.text, 320)}`);
  const injectedText = lines.length > 0
    ? `${MEMORY_RECALL_MARKER}\n${lines.join('\n')}`
    : '';

  const latencyMs = Date.now() - start;
  log.debug({
    query: truncate(query, 120),
    lexicalHits: lexicalCandidates.length,
    semanticHits: semanticCandidates.length,
    recencyHits: recencyCandidates.length,
    selected: selected.length,
    injectedTokens: estimateTextTokens(injectedText),
    latencyMs,
  }, 'Memory recall completed');

  return {
    enabled: true,
    degraded,
    reason,
    provider,
    model,
    lexicalHits: lexicalCandidates.length,
    semanticHits: semanticCandidates.length,
    recencyHits: recencyCandidates.length,
    injectedTokens: estimateTextTokens(injectedText),
    injectedText,
    latencyMs,
  };
}

export function stripMemoryRecallMessages<T extends { role: 'user' | 'assistant'; content: Array<{ type: string; text?: string }> }>(
  messages: T[],
): T[] {
  const cleaned: T[] = [];
  for (const message of messages) {
    const filteredContent = message.content.filter((block) => {
      if (block.type !== 'text') return true;
      return !(block.text ?? '').trim().startsWith(MEMORY_RECALL_MARKER);
    });
    if (filteredContent.length === 0) continue;
    if (filteredContent.length === message.content.length) {
      cleaned.push(message);
      continue;
    }
    cleaned.push({ ...message, content: filteredContent } as T);
  }
  return cleaned;
}

export function injectMemoryRecallIntoUserMessage<T extends { role: 'user' | 'assistant'; content: Array<{ type: string; text?: string }> }>(
  message: T,
  memoryRecallText: string,
): T {
  if (message.role !== 'user') return message;
  if (memoryRecallText.trim().length === 0) return message;
  const memoryBlock = { type: 'text', text: memoryRecallText } as const;
  return {
    ...message,
    content: [memoryBlock, ...message.content] as T['content'],
  } as T;
}

export function queryMemoryForCli(
  query: string,
  conversationId: string,
  config: AssistantConfig,
): Promise<MemoryRecallResult> {
  return buildMemoryRecall(query, conversationId, config);
}

function lexicalSearch(query: string, limit: number, excludedMessageIds: string[] = []): Candidate[] {
  const trimmed = query.trim();
  if (trimmed.length === 0 || limit <= 0) return [];
  const matchQuery = buildFtsMatchQuery(trimmed);
  if (!matchQuery) return [];
  const excluded = new Set(excludedMessageIds);
  const db = getDb();
  const raw = (db as unknown as { $client: { query: (q: string) => { all: (...params: unknown[]) => unknown[] } } }).$client;
  let rows: Array<{
    segment_id: string;
    message_id: string;
    text: string;
    created_at: number;
    rank: number;
  }> = [];
  const queryLimit = excluded.size > 0
    ? Math.max(limit + 24, limit * 2)
    : limit;
  try {
    rows = raw.query(`
      SELECT
        f.segment_id AS segment_id,
        s.message_id AS message_id,
        s.text AS text,
        s.created_at AS created_at,
        bm25(memory_segment_fts) AS rank
      FROM memory_segment_fts f
      JOIN memory_segments s ON s.id = f.segment_id
      WHERE memory_segment_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(matchQuery, queryLimit) as Array<{
      segment_id: string;
      message_id: string;
      text: string;
      created_at: number;
      rank: number;
    }>;
  } catch (err) {
    log.warn({ err, query: truncate(trimmed, 80) }, 'Memory lexical search query parse failed');
    return [];
  }

  const visibleRows = excluded.size > 0
    ? rows.filter((row) => !excluded.has(row.message_id)).slice(0, limit)
    : rows;

  const finiteRanks = visibleRows
    .map((row) => row.rank)
    .filter((rank) => Number.isFinite(rank));
  const minRank = finiteRanks.length > 0 ? Math.min(...finiteRanks) : 0;
  const maxRank = finiteRanks.length > 0 ? Math.max(...finiteRanks) : 0;

  return visibleRows.map((row) => {
    const lexical = lexicalRankToScore(row.rank, minRank, maxRank);
    return {
      key: `segment:${row.segment_id}`,
      type: 'segment',
      id: row.segment_id,
      text: row.text,
      confidence: 0.55,
      createdAt: row.created_at,
      lexical,
      semantic: 0,
      recency: computeRecencyScore(row.created_at),
      finalScore: 0,
    };
  });
}

async function semanticSearch(
  queryVector: number[],
  provider: string,
  model: string,
  limit: number,
): Promise<Candidate[]> {
  if (limit <= 0) return [];
  const db = getDb();
  const rows = db
    .select()
    .from(memoryEmbeddings)
    .where(and(
      eq(memoryEmbeddings.provider, provider),
      eq(memoryEmbeddings.model, model),
      inArray(memoryEmbeddings.targetType, ['item', 'summary']),
    ))
    .orderBy(desc(memoryEmbeddings.updatedAt))
    .limit(5000)
    .all();

  type Scored = { row: typeof memoryEmbeddings.$inferSelect; score: number };
  const scored: Scored[] = [];
  for (const row of rows) {
    const vector = parseVector(row.vectorJson);
    if (!vector) continue;
    const score = cosineSimilarity(queryVector, vector);
    scored.push({ row, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  const itemIds = top
    .filter((entry) => entry.row.targetType === 'item')
    .map((entry) => entry.row.targetId);
  const summaryIds = top
    .filter((entry) => entry.row.targetType === 'summary')
    .map((entry) => entry.row.targetId);

  const itemRows = itemIds.length > 0
    ? db.select().from(memoryItems).where(inArray(memoryItems.id, itemIds)).all()
    : [];
  const summaryRows = summaryIds.length > 0
    ? db.select().from(memorySummaries).where(inArray(memorySummaries.id, summaryIds)).all()
    : [];
  const itemMap = new Map(itemRows.map((item) => [item.id, item]));
  const summaryMap = new Map(summaryRows.map((summary) => [summary.id, summary]));

  const candidates: Candidate[] = [];
  for (const entry of top) {
    const semantic = mapCosineToUnit(entry.score);
    if (entry.row.targetType === 'item') {
      const item = itemMap.get(entry.row.targetId);
      if (!item || item.status !== 'active') continue;
      candidates.push({
        key: `item:${item.id}`,
        type: 'item',
        id: item.id,
        text: `[${item.kind}] ${item.subject}: ${item.statement}`,
        confidence: item.confidence,
        createdAt: item.lastSeenAt,
        lexical: 0,
        semantic,
        recency: computeRecencyScore(item.lastSeenAt),
        finalScore: 0,
      });
      continue;
    }
    const summary = summaryMap.get(entry.row.targetId);
    if (!summary) continue;
    candidates.push({
      key: `summary:${summary.id}`,
      type: 'summary',
      id: summary.id,
      text: `[${summary.scope}] ${summary.summary}`,
      confidence: 0.6,
      createdAt: summary.endAt,
      lexical: 0,
      semantic,
      recency: computeRecencyScore(summary.endAt),
      finalScore: 0,
    });
  }
  return candidates;
}

function recencySearch(conversationId: string, limit: number, excludedMessageIds: string[] = []): Candidate[] {
  if (!conversationId || limit <= 0) return [];
  const db = getDb();
  const whereClause = excludedMessageIds.length > 0
    ? and(
      eq(memorySegments.conversationId, conversationId),
      notInArray(memorySegments.messageId, excludedMessageIds),
    )
    : eq(memorySegments.conversationId, conversationId);
  const rows = db
    .select()
    .from(memorySegments)
    .where(whereClause)
    .orderBy(desc(memorySegments.createdAt))
    .limit(limit)
    .all();
  return rows.map((row) => ({
    key: `segment:${row.id}`,
    type: 'segment',
    id: row.id,
    text: row.text,
    confidence: 0.55,
    createdAt: row.createdAt,
    lexical: 0,
    semantic: 0,
    recency: computeRecencyScore(row.createdAt),
    finalScore: 0,
  }));
}

function mergeCandidates(
  lexical: Candidate[],
  semantic: Candidate[],
  recency: Candidate[],
): Candidate[] {
  const merged = new Map<string, Candidate>();
  for (const candidate of [...lexical, ...semantic, ...recency]) {
    const existing = merged.get(candidate.key);
    if (!existing) {
      merged.set(candidate.key, { ...candidate });
      continue;
    }
    existing.lexical = Math.max(existing.lexical, candidate.lexical);
    existing.semantic = Math.max(existing.semantic, candidate.semantic);
    existing.recency = Math.max(existing.recency, candidate.recency);
    existing.confidence = Math.max(existing.confidence, candidate.confidence);
    if (candidate.text.length > existing.text.length) {
      existing.text = candidate.text;
    }
  }

  const rows = [...merged.values()];
  for (const row of rows) {
    row.finalScore = (
      0.50 * row.semantic
      + 0.25 * row.lexical
      + 0.15 * row.recency
      + 0.10 * row.confidence
    );
  }

  rows.sort((a, b) => {
    const scoreDelta = b.finalScore - a.finalScore;
    if (scoreDelta !== 0) return scoreDelta;
    const createdAtDelta = b.createdAt - a.createdAt;
    if (createdAtDelta !== 0) return createdAtDelta;
    return a.key.localeCompare(b.key);
  });
  return rows;
}

function trimToTokenBudget(candidates: Candidate[], maxTokens: number): Candidate[] {
  if (maxTokens <= 0) return [];
  const selected: Candidate[] = [];
  let used = 0;
  for (const candidate of candidates) {
    const line = `- [${candidate.type}:${candidate.id}] ${truncate(candidate.text, 320)}`;
    const cost = estimateTextTokens(line);
    if (cost > maxTokens) continue;
    if (used + cost > maxTokens) continue;
    selected.push(candidate);
    used += cost;
    if (used >= maxTokens) break;
  }
  return selected;
}

function markItemUsage(candidates: Candidate[]): void {
  const itemIds = candidates.filter((candidate) => candidate.type === 'item').map((candidate) => candidate.id);
  if (itemIds.length === 0) return;
  const db = getDb();
  const now = Date.now();
  db.update(memoryItems)
    .set({ lastUsedAt: now })
    .where(inArray(memoryItems.id, itemIds))
    .run();
}

function lexicalRankToScore(rank: number, minRank: number, maxRank: number): number {
  if (!Number.isFinite(rank)) return 0;
  if (!Number.isFinite(minRank) || !Number.isFinite(maxRank)) return 0;
  const span = maxRank - minRank;
  if (span <= 0) return 1;
  // Lower BM25 rank is better in FTS5; normalize to [0,1] where 1 is best.
  return (maxRank - rank) / span;
}

function computeRecencyScore(createdAt: number): number {
  const ageMs = Math.max(0, Date.now() - createdAt);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return 1 / (1 + ageDays);
}

function mapCosineToUnit(value: number): number {
  return Math.max(0, Math.min(1, (value + 1) / 2));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function parseVector(raw: string): number[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    if (parsed.length === 0) return null;
    if (!parsed.every((value) => typeof value === 'number')) return null;
    return parsed as number[];
  } catch {
    return null;
  }
}

function emptyResult(
  init: Partial<MemoryRecallResult> & Pick<MemoryRecallResult, 'enabled' | 'degraded' | 'latencyMs'>,
): MemoryRecallResult {
  return {
    enabled: init.enabled,
    degraded: init.degraded,
    reason: init.reason,
    provider: init.provider,
    model: init.model,
    lexicalHits: 0,
    semanticHits: 0,
    recencyHits: 0,
    injectedTokens: 0,
    injectedText: '',
    latencyMs: init.latencyMs,
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function buildFtsMatchQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  if (tokens.length === 0) return null;
  const unique = [...new Set(tokens)].slice(0, 24);
  return unique
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' OR ');
}
