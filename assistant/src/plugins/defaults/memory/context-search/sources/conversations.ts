import {
  buildMessageExcerpt,
  hasLexicalTokens,
  searchMessageIdsLexical,
} from "@vellumai/plugin-api";

import { readSlackMetadata } from "../../../../../messaging/providers/slack/message-metadata.js";
import { AUTO_ANALYSIS_SOURCE } from "../../../../../persistence/auto-analysis-constants.js";
import { isLexicalBackfillComplete } from "../../../../../persistence/checkpoints.js";
import { rawAll } from "../../../../../persistence/raw-query.js";
import {
  parseExternalContentEnvelope,
  wrapUntrustedContent,
} from "../../../../../security/untrusted-content.js";
import { getLogger } from "../../logging.js";
import type { RecallSearchContext, RecallSearchResult } from "../types.js";

const log = getLogger("recall-conversations-source");

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

/**
 * Qdrant candidate over-fetch multiplier for the lexical read path.
 *
 * The read fetches ranked message-id candidates first and filters them in SQL
 * afterwards (Qdrant has no visibility filtering), so it must over-fetch
 * enough candidates that excluded rows (the active conversation,
 * subagent/auto-analysis/notification sources, private history) don't starve
 * the post-filter pool. A generous candidate pool is cheap — the final
 * consumer takes top-N after the app-side scorer anyway.
 *
 * This is a proportionate over-fetch, NOT a hard guarantee: a query whose
 * visible matches all rank beyond the widened window can still be
 * under-filled. A stronger fix would need pagination or Qdrant group-search.
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

  // The Qdrant lexical index — the only source of conversation evidence — is
  // populated unconditionally (host-owned message-search indexing), but until
  // the one-time upgrade backfill has fully drained it holds only messages
  // written since the write path went live. A qdrant read then would silently
  // miss older content (an empty candidate set, not a throw), so the source
  // yields no evidence instead of serving misleading partial results. The
  // completion checkpoint is shared with the persistence read site.
  if (!isLexicalBackfillComplete()) {
    return { evidence: [] };
  }

  // Short/punctuation-only queries (`C++`, CJK) produce no usable ≥2-char
  // token. Content matching is index-only, so such queries yield no
  // conversation evidence. The early return also keeps the sparse encoder
  // honest: it still emits a 1-char token for these queries, so querying the
  // index anyway would return noisy hits.
  if (!(await hasLexicalTokens(trimmedQuery))) {
    return { evidence: [] };
  }

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
  const rows = await gatherCandidateRowsFromQdrant(
    trimmedQuery,
    qdrantCandidateLimit,
    context.conversationId,
  );

  const sortedRows = rows
    .map((row) => ({
      row,
      score: scoreConversationRow(row, trimmedQuery),
    }))
    .sort(compareScoredConversationRows)
    .slice(0, normalizedLimit);

  return {
    evidence: await Promise.all(
      sortedRows.map(async ({ row, score }) => ({
        id: `conversations:${row.conversation_id}:${row.message_id}`,
        source: "conversations",
        title: row.title?.trim() || "Untitled conversation",
        locator: `${row.conversation_id}#${row.message_id}`,
        excerpt: await buildRecallExcerpt(row, trimmedQuery),
        timestampMs: row.created_at,
        score,
        metadata: {
          role: row.role,
          conversationId: row.conversation_id,
        },
      })),
    ),
  };
}

/**
 * Generate candidate rows via the Qdrant lexical index. Qdrant is
 * candidate-generation only: it supplies over-fetched message-id candidates
 * (ranked by sparse score) whose rows are then re-fetched with the
 * source/type/excluded-conversation predicates applied in SQL
 * ({@link searchByIds}). Final ordering stays with the app-side scorer.
 *
 * `candidateLimit` is the widened over-fetch count (see
 * {@link QDRANT_RECALL_CANDIDATE_MULTIPLIER}) — it bounds both the Qdrant fetch
 * and the post-filter SQL `LIMIT`, so surviving candidates aren't dropped
 * before scoring. Filtering shrinks the pool but never grows it, so the final
 * `LIMIT` is a no-op ceiling here; it exists only to bound the returned rows.
 *
 * Returns an empty array when the query tokenizes to no sparse terms (the
 * lexical helper's empty guard) or when the Qdrant call throws (logged) — the
 * source then yields no conversation evidence for the query.
 */
async function gatherCandidateRowsFromQdrant(
  query: string,
  candidateLimit: number,
  excludedConversationId: string,
): Promise<ConversationEvidenceRow[]> {
  let candidates: Array<{ messageId: string }>;
  try {
    candidates = await searchMessageIdsLexical(query, candidateLimit);
  } catch (err) {
    log.warn(
      { err, query: query.slice(0, 80) },
      "recall conversations source: Qdrant lexical query failed — no conversation evidence for this query",
    );
    return [];
  }

  const candidateIds = candidates.map((candidate) => candidate.messageId);
  if (candidateIds.length === 0) {
    return [];
  }

  return searchByIds(candidateIds, candidateLimit, excludedConversationId);
}

/**
 * Fetch evidence rows for an explicit set of candidate message ids, applying
 * the source/type/excluded-conversation predicates in SQL (Qdrant has no
 * visibility filtering). The app-side scorer determines final ordering, so
 * the SQL tie-break falls back to recency.
 */
function searchByIds(
  messageIds: readonly string[],
  limit: number,
  excludedConversationId: string,
): ConversationEvidenceRow[] {
  const placeholders = messageIds.map(() => "?").join(", ");
  return rawAll<ConversationEvidenceRow>(
    "convSearch:searchByIds",
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

async function buildRecallExcerpt(
  row: ConversationEvidenceRow,
  query: string,
): Promise<string> {
  const excerpt = await buildMessageExcerpt(row.content, query);
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
  if (!rawMetadata) {
    return null;
  }

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
  if (typeof metadata.slackMeta !== "string") {
    return null;
  }
  const slackMeta = readSlackMetadata(metadata.slackMeta);
  if (!slackMeta) {
    return null;
  }

  return {
    ...(slackMeta.displayName ? { displayName: slackMeta.displayName } : {}),
    ...(typeof metadata.provenanceTrustClass === "string"
      ? { provenanceTrustClass: metadata.provenanceTrustClass }
      : {}),
  };
}

function tokenizeSalientRecallTerms(text: string): string[] {
  const terms = (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
    (term) => term.length >= 2 && !NON_SALIENT_RECALL_TERMS.has(term),
  );
  return [...new Set(terms)].slice(0, 12);
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
  if (scoreCompare !== 0) {
    return scoreCompare;
  }
  return b.row.created_at - a.row.created_at;
}
