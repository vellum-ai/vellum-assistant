import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { getLogger } from '../../util/logger.js';
import { getDb } from '../db.js';
import { memorySegments } from '../schema.js';
import type { Candidate, CandidateType } from './types.js';
import { computeRecencyScore } from './ranking.js';

const log = getLogger('memory-retriever');

export function lexicalSearch(query: string, limit: number, excludedMessageIds: string[] = [], scopeIds?: string[]): Candidate[] {
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
  const scopeClause = scopeIds
    ? ` AND s.scope_id IN (${scopeIds.map(() => '?').join(',')})`
    : '';
  const params: unknown[] = [matchQuery, ...(scopeIds ?? []), queryLimit];
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
      WHERE memory_segment_fts MATCH ?${scopeClause}
      ORDER BY rank
      LIMIT ?
    `).all(...params) as Array<{
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
      type: 'segment' as CandidateType,
      id: row.segment_id,
      source: 'lexical',
      text: row.text,
      kind: 'segment',
      confidence: 0.55,
      importance: 0.5,
      createdAt: row.created_at,
      lexical,
      semantic: 0,
      recency: computeRecencyScore(row.created_at),
      finalScore: 0,
    };
  });
}

export function recencySearch(conversationId: string, limit: number, excludedMessageIds: string[] = [], scopeIds?: string[]): Candidate[] {
  if (!conversationId || limit <= 0) return [];
  const db = getDb();
  const conditions = [eq(memorySegments.conversationId, conversationId)];
  if (excludedMessageIds.length > 0) {
    conditions.push(notInArray(memorySegments.messageId, excludedMessageIds));
  }
  if (scopeIds && scopeIds.length > 0) {
    conditions.push(inArray(memorySegments.scopeId, scopeIds));
  }
  const whereClause = conditions.length > 1 ? and(...conditions) : conditions[0];
  const rows = db
    .select()
    .from(memorySegments)
    .where(whereClause)
    .orderBy(desc(memorySegments.createdAt))
    .limit(limit)
    .all();
  return rows.map((row) => ({
    key: `segment:${row.id}`,
    type: 'segment' as CandidateType,
    id: row.id,
    source: 'recency',
    text: row.text,
    kind: 'segment',
    confidence: 0.55,
    importance: 0.5,
    createdAt: row.createdAt,
    lexical: 0,
    semantic: 0,
    recency: computeRecencyScore(row.createdAt),
    finalScore: 0,
  }));
}

/**
 * Direct search over memory_items table by subject and statement text.
 * Supplements FTS-based lexical search with LIKE-based matching on items.
 */
export function directItemSearch(query: string, limit: number, scopeIds?: string[]): Candidate[] {
  const db = getDb();
  const tokens = [...new Set(query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/g)
    .filter((t) => t.length >= 2))];
  if (tokens.length === 0) return [];

  const raw = (db as unknown as { $client: { query: (q: string) => { all: (...params: unknown[]) => unknown[] } } }).$client;
  const likeClauses = tokens.map(
    () => `(LOWER(subject) LIKE ? OR LOWER(statement) LIKE ?)`,
  );
  const likeParams = tokens.flatMap((t) => {
    const pattern = `%${escapeLikeWildcards(t)}%`;
    return [pattern, pattern];
  });
  const scopeClause = scopeIds
    ? ` AND scope_id IN (${scopeIds.map(() => '?').join(',')})`
    : '';
  const sqlQuery = `
    SELECT id, kind, subject, statement, status, confidence, importance, first_seen_at, last_seen_at
    FROM memory_items
    WHERE status = 'active' AND invalid_at IS NULL AND (${likeClauses.join(' OR ')})${scopeClause}
    ORDER BY last_seen_at DESC
    LIMIT ?
  `;
  const params: unknown[] = [...likeParams, ...(scopeIds ?? []), limit];

  let rows: Array<{
    id: string;
    kind: string;
    subject: string;
    statement: string;
    confidence: number;
    importance: number | null;
    first_seen_at: number;
    last_seen_at: number;
  }> = [];
  try {
    rows = raw.query(sqlQuery).all(...params) as typeof rows;
  } catch {
    return [];
  }

  return rows.map((row) => {
    // Compute lexical score based on token match coverage: fraction of query
    // tokens that appear in subject or statement. Direct items are keyword
    // matches so this score reflects query-match relevance (unlike confidence,
    // which reflects extraction certainty).
    const textLower = `${row.subject} ${row.statement}`.toLowerCase();
    const matchedTokens = tokens.filter((t) => textLower.includes(t)).length;
    const lexical = tokens.length > 0 ? matchedTokens / tokens.length : 0;

    return {
      key: `item:${row.id}`,
      type: 'item' as CandidateType,
      id: row.id,
      source: 'item_direct',
      text: `${row.subject}: ${row.statement}`,
      kind: row.kind,
      confidence: row.confidence,
      importance: row.importance ?? 0.5,
      createdAt: row.last_seen_at,
      lexical,
      semantic: 0,
      recency: computeRecencyScore(row.last_seen_at),
      finalScore: 0,
    };
  });
}

export function lexicalRankToScore(rank: number, minRank: number, maxRank: number): number {
  if (!Number.isFinite(rank)) return 0;
  if (!Number.isFinite(minRank) || !Number.isFinite(maxRank)) return 0;
  const span = maxRank - minRank;
  if (span <= 0) return 1;
  // Lower BM25 rank is better in FTS5; normalize to [0,1] where 1 is best.
  return (maxRank - rank) / span;
}

export function buildFtsMatchQuery(text: string): string | null {
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

export function escapeLikeWildcards(s: string): string {
  return s.replace(/%/g, '').replace(/_/g, '');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}
