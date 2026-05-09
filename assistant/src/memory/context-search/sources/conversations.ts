import { AUTO_ANALYSIS_SOURCE } from "../../auto-analysis-guard.js";
import {
  buildExcerpt,
  buildFtsMatchQuery,
} from "../../conversation-queries.js";
import { rawAll } from "../../raw-query.js";
import type { RecallSearchContext, RecallSearchResult } from "../types.js";

const SUBAGENT_SOURCE = "subagent";
const NOTIFICATION_SOURCE = "notification";

interface ConversationEvidenceRow {
  message_id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: number;
  title: string | null;
}

const CONVERSATION_SEARCH_PREFETCH_MULTIPLIER = 5;

const NON_SALIENT_RECALL_TERMS = new Set([
  "a",
  "about",
  "and",
  "any",
  "as",
  "asked",
  "being",
  "details",
  "detail",
  "find",
  "for",
  "from",
  "get",
  "give",
  "happened",
  "include",
  "included",
  "including",
  "is",
  "it",
  "me",
  "of",
  "on",
  "or",
  "recipient",
  "referred",
  "relevant",
  "should",
  "tell",
  "that",
  "the",
  "thing",
  "timing",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

export async function searchConversationSource(
  query: string,
  context: RecallSearchContext,
  limit: number,
): Promise<RecallSearchResult> {
  const trimmedQuery = query.trim();
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : 0;

  if (!trimmedQuery || normalizedLimit === 0) {
    return { evidence: [] };
  }

  const queryLimit = Math.max(
    normalizedLimit,
    normalizedLimit * CONVERSATION_SEARCH_PREFETCH_MULTIPLIER,
  );
  const ftsMatches = buildRecallFtsMatchQueries(trimmedQuery);
  let rows: ConversationEvidenceRow[] = [];

  for (const ftsMatch of ftsMatches) {
    try {
      rows = mergeConversationRows(
        rows,
        searchWithFts(ftsMatch, queryLimit, context.conversationId),
      );
    } catch {
      // Try the next, broader query shape.
    }

    if (rows.length >= normalizedLimit) break;
  }

  if (rows.length === 0) {
    rows = searchWithLike(trimmedQuery, queryLimit, context.conversationId);
  }

  const sortedRows = rows
    .map((row) => ({
      row,
      score: scoreConversationRow(row, trimmedQuery),
    }))
    .sort(compareScoredConversationRows)
    .slice(0, normalizedLimit);

  return {
    evidence: sortedRows.map(({ row, score }) => ({
      id: `conversations:${row.conversation_id}:${row.message_id}`,
      source: "conversations",
      title: row.title?.trim() || "Untitled conversation",
      locator: `${row.conversation_id}#${row.message_id}`,
      excerpt: buildExcerpt(row.content, trimmedQuery),
      timestampMs: row.created_at,
      score,
      metadata: {
        role: row.role,
        conversationId: row.conversation_id,
      },
    })),
  };
}

function searchWithFts(
  ftsMatch: string,
  limit: number,
  excludedConversationId: string,
): ConversationEvidenceRow[] {
  return rawAll<ConversationEvidenceRow>(
    `
    SELECT
      m.id AS message_id,
      m.conversation_id,
      m.role,
      m.content,
      m.created_at,
      c.title
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.message_id
    JOIN conversations c ON c.id = m.conversation_id
    WHERE messages_fts MATCH ?
      AND (c.conversation_type IS NULL OR c.conversation_type != 'private')
      AND (c.source IS NULL OR c.source NOT IN (?, ?, ?))
      AND c.id != ?
    ORDER BY bm25(messages_fts), m.created_at DESC
    LIMIT ?
    `,
    ftsMatch,
    SUBAGENT_SOURCE,
    AUTO_ANALYSIS_SOURCE,
    NOTIFICATION_SOURCE,
    excludedConversationId,
    limit,
  );
}

function searchWithLike(
  query: string,
  limit: number,
  excludedConversationId: string,
): ConversationEvidenceRow[] {
  return rawAll<ConversationEvidenceRow>(
    `
    SELECT
      m.id AS message_id,
      m.conversation_id,
      m.role,
      m.content,
      m.created_at,
      c.title
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.content LIKE ? ESCAPE '\\'
      AND (c.conversation_type IS NULL OR c.conversation_type != 'private')
      AND (c.source IS NULL OR c.source NOT IN (?, ?, ?))
      AND c.id != ?
    ORDER BY m.created_at DESC
    LIMIT ?
    `,
    buildLikePattern(query),
    SUBAGENT_SOURCE,
    AUTO_ANALYSIS_SOURCE,
    NOTIFICATION_SOURCE,
    excludedConversationId,
    limit,
  );
}

function buildRecallFtsMatchQueries(query: string): string[] {
  const queries: string[] = [];
  const exact = buildFtsMatchQuery(query);
  if (exact) {
    queries.push(exact);
  }

  const salientTerms = tokenizeSalientRecallTerms(query);
  if (salientTerms.length > 0) {
    const salientAnd = salientTerms.map(quoteFtsToken).join(" ");
    if (salientAnd && !queries.includes(salientAnd)) {
      queries.push(salientAnd);
    }

    if (salientTerms.length > 1) {
      const salientOr = salientTerms.map(quoteFtsToken).join(" OR ");
      if (!queries.includes(salientOr)) {
        queries.push(salientOr);
      }
    }
  }

  return queries;
}

function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function tokenizeSalientRecallTerms(text: string): string[] {
  const terms = (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
    (term) => term.length >= 2 && !NON_SALIENT_RECALL_TERMS.has(term),
  );
  return [...new Set(terms)].slice(0, 12);
}

function mergeConversationRows(
  existing: readonly ConversationEvidenceRow[],
  next: readonly ConversationEvidenceRow[],
): ConversationEvidenceRow[] {
  const seen = new Set(existing.map((row) => row.message_id));
  const merged = [...existing];
  for (const row of next) {
    if (seen.has(row.message_id)) {
      continue;
    }
    seen.add(row.message_id);
    merged.push(row);
  }
  return merged;
}

function scoreConversationRow(
  row: ConversationEvidenceRow,
  query: string,
): number {
  const queryTerms = tokenizeSalientRecallTerms(query);
  if (queryTerms.length === 0) {
    return 0;
  }

  const haystackTerms = new Set(
    tokenizeSalientRecallTerms(`${row.title ?? ""}\n${row.content}`),
  );
  const matchedTerms = queryTerms.filter((term) => haystackTerms.has(term));
  const titleTerms = new Set(tokenizeSalientRecallTerms(row.title ?? ""));
  const titleMatches = queryTerms.filter((term) => titleTerms.has(term));
  return matchedTerms.length / queryTerms.length + titleMatches.length * 0.05;
}

function compareScoredConversationRows(
  a: { row: ConversationEvidenceRow; score: number },
  b: { row: ConversationEvidenceRow; score: number },
): number {
  const scoreCompare = b.score - a.score;
  if (scoreCompare !== 0) return scoreCompare;
  return b.row.created_at - a.row.created_at;
}

function buildLikePattern(query: string): string {
  return `%${query
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")}%`;
}
