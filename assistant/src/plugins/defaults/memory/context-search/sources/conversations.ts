import { readSlackMetadata } from "../../../../../messaging/providers/slack/message-metadata.js";
import { AUTO_ANALYSIS_SOURCE } from "../../../../../persistence/auto-analysis-constants.js";
import { isLexicalBackfillComplete } from "../../../../../persistence/checkpoints.js";
import {
  buildFtsMatchQuery,
  buildRecallEvidenceExcerpt,
} from "../../../../../persistence/conversation-queries.js";
import { searchMessageIdsLexical } from "../../../../../persistence/conversation-search-lexical.js";
import { rawAll } from "../../../../../persistence/raw-query.js";
import {
  parseExternalContentEnvelope,
  wrapUntrustedContent,
} from "../../../../../security/untrusted-content.js";
import { isMemoryIndexingSuppressed } from "../../job-handlers/index-message-lexical.js";
import type { RecallSearchContext, RecallSearchResult } from "../types.js";

const SUBAGENT_SOURCE = "subagent";
const NOTIFICATION_SOURCE = "notification";

interface ConversationEvidenceRow {
  message_id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: number;
  metadata: string | null;
  title: string | null;
}

const CONVERSATION_SEARCH_PREFETCH_MULTIPLIER = 5;

/**
 * Qdrant candidate over-fetch multiplier for the lexical read path.
 *
 * FTS applies the source/type/excluded-conversation predicates *inside* SQL
 * before its LIMIT, so its post-filter window is already correct. The Qdrant
 * path instead fetches ranked message-id candidates first and filters them in
 * SQL afterwards, so it must over-fetch enough candidates that excluded rows
 * (the active conversation, subagent/auto-analysis/notification sources,
 * private history) don't starve the post-filter pool. This is deliberately
 * larger than the FTS prefetch multiplier — a generous candidate pool is cheap
 * (the final consumer takes top-N after the app-side scorer anyway).
 *
 * This is a proportionate over-fetch, NOT a hard parity guarantee: a query
 * whose visible matches all rank beyond the widened window can still be
 * under-filled. True parity would need pagination or Qdrant group-search;
 * that stronger fix is deferred to pre-flip hardening if Gate A shows recall
 * regressions.
 */
const QDRANT_RECALL_CANDIDATE_MULTIPLIER = 20;

/**
 * Floor for the Qdrant candidate pool, so small `max_results` requests still
 * over-fetch a healthy number of candidates before SQL filtering. Recall's
 * `max_results` is capped at `MAX_RECALL_MAX_RESULTS` (20), so the pool is
 * bounded at 20 × 20 = 400 candidate ids — far under the SQLite bound-variable
 * limit (32766), so the `WHERE m.id IN (...)` query needs no chunking.
 */
const QDRANT_RECALL_MIN_CANDIDATES = 200;

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

  // The Qdrant lexical index is forward-filled by the memory write path, which
  // is gated on `isMemoryIndexingSuppressed()`. When indexing is suppressed
  // (memory disabled or the memory plugin disabled) the collection is never
  // populated, so a qdrant-backed read would silently return nothing while FTS
  // still works — force the FTS path in that case.
  //
  // Second gate: until the one-time upgrade backfill has fully drained, the
  // collection holds only messages written since the write path went live —
  // older history is missing. Reading from Qdrant then silently misses that
  // history (an empty candidate set, not a throw), so stay on FTS until
  // `isLexicalBackfillComplete()` confirms the index is whole. Shared with the
  // persistence read site via the same checkpoint helper.
  const backend =
    isMemoryIndexingSuppressed() || !isLexicalBackfillComplete()
      ? "fts5"
      : "qdrant";

  // Tokenize once. Short/punctuation-only queries (`C++`, CJK) produce no
  // usable ≥2-char match shape, and both backends must route those straight to
  // the exact `searchWithLike` path — the FTS path already does (an empty match
  // list yields no rows and falls through to LIKE below). The Qdrant path needs
  // this guard explicitly: the sparse encoder still emits a 1-char token for
  // such queries, so it would return noisy hits and wrongly skip the exact-LIKE
  // fallback. Only query a lexical index when the query genuinely tokenizes.
  const ftsMatches = buildRecallFtsMatchQueries(trimmedQuery);

  let rows: ConversationEvidenceRow[];
  if (ftsMatches.length === 0) {
    rows = searchWithLike(trimmedQuery, queryLimit, context.conversationId);
  } else if (backend === "qdrant") {
    // A brief post-edit staleness window (an edited message whose re-index job
    // has not yet run, or a just-deleted message still present as a point) is
    // an ACCEPTED consequence of async indexing. Recall is fuzzy evidence
    // re-ranked by the app-side scorer, and the wide candidate pool dilutes a
    // single stale hit; we do not re-verify candidate content against the query
    // (a substring re-check would wrongly drop valid stemmed matches).
    const qdrantCandidateLimit = Math.max(
      normalizedLimit * QDRANT_RECALL_CANDIDATE_MULTIPLIER,
      QDRANT_RECALL_MIN_CANDIDATES,
    );
    rows = await gatherCandidateRowsFromQdrant(
      trimmedQuery,
      qdrantCandidateLimit,
      context.conversationId,
    );
  } else {
    rows = gatherCandidateRowsFromFts(
      ftsMatches,
      queryLimit,
      normalizedLimit,
      context.conversationId,
    );
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
      excerpt: buildRecallExcerpt(row, trimmedQuery),
      timestampMs: row.created_at,
      score,
      metadata: {
        role: row.role,
        conversationId: row.conversation_id,
      },
    })),
  };
}

/**
 * Generate candidate rows via SQLite FTS5 from precomputed match shapes. Walks
 * the shapes (progressively broader), merging matches until enough rows are
 * collected, and swallows a malformed-query error on any single shape so a
 * broader shape can still run. Returns an empty array when no shape matches —
 * the caller then degrades to the LIKE fallback.
 */
function gatherCandidateRowsFromFts(
  ftsMatches: readonly string[],
  queryLimit: number,
  normalizedLimit: number,
  excludedConversationId: string,
): ConversationEvidenceRow[] {
  let rows: ConversationEvidenceRow[] = [];

  for (const ftsMatch of ftsMatches) {
    try {
      rows = mergeConversationRows(
        rows,
        searchWithFts(ftsMatch, queryLimit, excludedConversationId),
      );
    } catch {
      // Try the next, broader query shape.
    }

    if (rows.length >= normalizedLimit) break;
  }

  return rows;
}

/**
 * Generate candidate rows via the Qdrant lexical index. Qdrant is
 * candidate-generation only: it supplies over-fetched message-id candidates
 * (ranked by sparse score) whose rows are then re-fetched with the exact same
 * source/type/excluded-conversation predicates FTS applies, so only the
 * candidate *source* differs. Final ordering stays with the app-side scorer.
 *
 * `candidateLimit` is the widened over-fetch count (see
 * {@link QDRANT_RECALL_CANDIDATE_MULTIPLIER}) — it bounds both the Qdrant fetch
 * and the post-filter SQL `LIMIT`, so surviving candidates aren't dropped
 * before scoring. Filtering shrinks the pool but never grows it, so the final
 * `LIMIT` is a no-op ceiling here; it exists only to bound the returned rows.
 *
 * Returns an empty array when the query tokenizes to no sparse terms (the
 * lexical helper's empty guard) or when the Qdrant call throws — in both cases
 * the caller degrades to the LIKE fallback, mirroring how the FTS path falls
 * back when it matches nothing.
 */
async function gatherCandidateRowsFromQdrant(
  query: string,
  candidateLimit: number,
  excludedConversationId: string,
): Promise<ConversationEvidenceRow[]> {
  let candidates: Array<{ messageId: string }>;
  try {
    candidates = await searchMessageIdsLexical(query, candidateLimit);
  } catch {
    return [];
  }

  const candidateIds = candidates.map((candidate) => candidate.messageId);
  if (candidateIds.length === 0) return [];

  return searchByIds(candidateIds, candidateLimit, excludedConversationId);
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
      m.metadata,
      c.title
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.message_id
    JOIN conversations c ON c.id = m.conversation_id
    WHERE messages_fts MATCH ?
      AND (c.source IS NULL OR c.source NOT IN (?, ?, ?))
      AND c.id != ?
      AND c.conversation_type != 'private'
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

/**
 * Fetch evidence rows for an explicit set of candidate message ids, applying
 * the identical source/type/excluded-conversation predicates `searchWithFts`
 * enforces. Only the candidate source differs (`m.id IN (...)` vs
 * `messages_fts MATCH`); the app-side scorer determines final ordering, so the
 * SQL tie-break falls back to recency.
 */
function searchByIds(
  messageIds: readonly string[],
  limit: number,
  excludedConversationId: string,
): ConversationEvidenceRow[] {
  const placeholders = messageIds.map(() => "?").join(", ");
  return rawAll<ConversationEvidenceRow>(
    `
    SELECT
      m.id AS message_id,
      m.conversation_id,
      m.role,
      m.content,
      m.created_at,
      m.metadata,
      c.title
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id IN (${placeholders})
      AND (c.source IS NULL OR c.source NOT IN (?, ?, ?))
      AND c.id != ?
      AND c.conversation_type != 'private'
    ORDER BY m.created_at DESC
    LIMIT ?
    `,
    ...messageIds,
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
      m.metadata,
      c.title
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.content LIKE ? ESCAPE '\\'
      AND (c.source IS NULL OR c.source NOT IN (?, ?, ?))
      AND c.id != ?
      AND c.conversation_type != 'private'
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

function buildRecallExcerpt(
  row: ConversationEvidenceRow,
  query: string,
): string {
  const excerpt = buildRecallEvidenceExcerpt(row.content, query);
  const slackMeta = parseSlackRecallMetadata(row.metadata);
  if (
    row.role !== "user" ||
    !slackMeta ||
    slackMeta.provenanceTrustClass === "guardian" ||
    excerpt.length === 0 ||
    parseExternalContentEnvelope(excerpt)
  ) {
    return excerpt;
  }

  return wrapUntrustedContent(excerpt, {
    source: "slack",
    ...(slackMeta.displayName ? { sourceDetail: slackMeta.displayName } : {}),
  });
}

function parseSlackRecallMetadata(rawMetadata: string | null): {
  displayName?: string;
  provenanceTrustClass?: string;
} | null {
  if (!rawMetadata) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMetadata);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const metadata = parsed as Record<string, unknown>;
  if (typeof metadata.slackMeta !== "string") return null;
  const slackMeta = readSlackMetadata(metadata.slackMeta);
  if (!slackMeta) return null;

  return {
    ...(slackMeta.displayName ? { displayName: slackMeta.displayName } : {}),
    ...(typeof metadata.provenanceTrustClass === "string"
      ? { provenanceTrustClass: metadata.provenanceTrustClass }
      : {}),
  };
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
