import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import type { AssistantConfig } from '../config/types.js';
import { estimateTextTokens } from '../context/token-estimator.js';
import { getLogger } from '../util/logger.js';
import { embedWithBackend, getMemoryBackendStatus, logMemoryEmbeddingWarning } from './embedding-backend.js';
import { getDb } from './db.js';
import { getQdrantClient } from './qdrant-client.js';
import { memoryItems, memorySegments } from './schema.js';

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
  signal?: AbortSignal;
}

export async function buildMemoryRecall(
  query: string,
  conversationId: string,
  config: AssistantConfig,
  options?: MemoryRecallOptions,
): Promise<MemoryRecallResult> {
  const start = Date.now();
  const excludeMessageIds = options?.excludeMessageIds?.filter((id) => id.length > 0) ?? [];
  const signal = options?.signal;
  if (!config.memory.enabled) {
    return emptyResult({ enabled: false, degraded: false, reason: 'memory.disabled', latencyMs: Date.now() - start });
  }
  if (signal?.aborted) {
    return emptyResult({ enabled: true, degraded: false, reason: 'memory.aborted', latencyMs: Date.now() - start });
  }

  const backendStatus = getMemoryBackendStatus(config);
  let queryVector: number[] | null = null;
  let provider: string | undefined;
  let model: string | undefined;
  let degraded = backendStatus.degraded;
  let reason = backendStatus.reason ?? undefined;

  if (backendStatus.provider) {
    try {
      const embedded = await embedWithBackend(config, [query], { signal });
      queryVector = embedded.vectors[0] ?? null;
      provider = embedded.provider;
      model = embedded.model;
      degraded = false;
      reason = undefined;
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) {
        return emptyResult({
          enabled: true,
          degraded: false,
          reason: 'memory.aborted',
          provider: backendStatus.provider,
          model: backendStatus.model ?? undefined,
          latencyMs: Date.now() - start,
        });
      }
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
      ? await semanticSearch(queryVector, provider!, model!, config.memory.retrieval.semanticTopK, excludeMessageIds)
      : [];
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) {
      return emptyResult({
        enabled: true,
        degraded: false,
        reason: 'memory.aborted',
        provider,
        model,
        latencyMs: Date.now() - start,
      });
    }
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
  const selected = trimToTokenBudget(merged, config.memory.retrieval.maxInjectTokens, MEMORY_RECALL_MARKER);
  markItemUsage(selected);

  const injectedText = buildInjectedText(selected, MEMORY_RECALL_MARKER);

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
  memoryRecallText?: string,
): T[] {
  const recallText = memoryRecallText ?? '';
  if (recallText.trim().length === 0) return messages;

  let targetIndex = -1;
  let blockIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'user' || message.content.length === 0) continue;
    let foundBlock = -1;
    for (let bi = message.content.length - 1; bi >= 0; bi--) {
      const block = message.content[bi];
      if (block.type === 'text' && block.text === recallText) {
        foundBlock = bi;
        break;
      }
    }
    if (foundBlock !== -1) {
      targetIndex = index;
      blockIndex = foundBlock;
      break;
    }
  }
  if (targetIndex === -1) return messages;

  const cleaned: T[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (index !== targetIndex) {
      cleaned.push(message);
      continue;
    }
    const filteredContent = [
      ...message.content.slice(0, blockIndex),
      ...message.content.slice(blockIndex + 1),
    ];
    if (filteredContent.length === 0) continue;
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
  _provider: string,
  _model: string,
  limit: number,
  excludedMessageIds: string[] = [],
): Promise<Candidate[]> {
  if (limit <= 0) return [];

  let qdrant: ReturnType<typeof getQdrantClient>;
  try {
    qdrant = getQdrantClient();
  } catch {
    log.warn('Qdrant client not initialized, skipping semantic search');
    return [];
  }

  const results = await qdrant.searchWithFilter(
    queryVector,
    limit,
    ['item', 'summary', 'segment'],
    excludedMessageIds,
  );

  const candidates: Candidate[] = [];
  for (const result of results) {
    const { payload, score } = result;
    const semantic = mapCosineToUnit(score);
    const createdAt = payload.created_at ?? Date.now();

    if (payload.target_type === 'item') {
      candidates.push({
        key: `item:${payload.target_id}`,
        type: 'item',
        id: payload.target_id,
        text: payload.text,
        confidence: payload.confidence ?? 0.6,
        createdAt: payload.last_seen_at ?? createdAt,
        lexical: 0,
        semantic,
        recency: computeRecencyScore(payload.last_seen_at ?? createdAt),
        finalScore: 0,
      });
    } else if (payload.target_type === 'summary') {
      candidates.push({
        key: `summary:${payload.target_id}`,
        type: 'summary',
        id: payload.target_id,
        text: payload.text,
        confidence: 0.6,
        createdAt: payload.last_seen_at ?? createdAt,
        lexical: 0,
        semantic,
        recency: computeRecencyScore(payload.last_seen_at ?? createdAt),
        finalScore: 0,
      });
    } else {
      candidates.push({
        key: `segment:${payload.target_id}`,
        type: 'segment',
        id: payload.target_id,
        text: payload.text,
        confidence: 0.55,
        createdAt,
        lexical: 0,
        semantic,
        recency: computeRecencyScore(createdAt),
        finalScore: 0,
      });
    }
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

function trimToTokenBudget(candidates: Candidate[], maxTokens: number, marker: string): Candidate[] {
  if (maxTokens <= 0) return [];
  const selected: Candidate[] = [];
  for (const candidate of candidates) {
    const tentativeText = buildInjectedText([...selected, candidate], marker);
    const cost = estimateTextTokens(tentativeText);
    if (cost > maxTokens) continue;
    selected.push(candidate);
    if (cost >= maxTokens) break;
  }
  return selected;
}

function buildInjectedText(candidates: Candidate[], marker: string): string {
  if (candidates.length === 0) return '';
  return `${marker}\n${candidates.map(formatCandidateLine).join('\n')}`;
}

function formatCandidateLine(candidate: Candidate): string {
  return `- [${candidate.type}:${candidate.id}] ${truncate(candidate.text, 320)}`;
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

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'APIUserAbortError';
}
