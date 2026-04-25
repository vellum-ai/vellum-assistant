import { AUTO_ANALYSIS_SOURCE } from "../../auto-analysis-guard.js";
import {
  buildExcerpt,
  buildFtsMatchQuery,
} from "../../conversation-queries.js";
import { rawAll } from "../../db.js";
import type { RecallSearchContext, RecallSearchResult } from "../types.js";

const SUBAGENT_SOURCE = "subagent";

interface ConversationEvidenceRow {
  message_id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: number;
  title: string | null;
}

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

  const ftsMatch = buildFtsMatchQuery(trimmedQuery);
  let rows: ConversationEvidenceRow[] = [];

  if (ftsMatch) {
    try {
      rows = searchWithFts(ftsMatch, context.memoryScopeId, normalizedLimit);
    } catch {
      rows = [];
    }
  }

  if (rows.length === 0) {
    rows = searchWithLike(trimmedQuery, context.memoryScopeId, normalizedLimit);
  }

  return {
    evidence: rows.map((row) => ({
      id: `conversations:${row.conversation_id}:${row.message_id}`,
      source: "conversations",
      title: row.title?.trim() || "Untitled conversation",
      locator: `${row.conversation_id}#${row.message_id}`,
      excerpt: buildExcerpt(row.content, trimmedQuery),
      timestampMs: row.created_at,
      metadata: {
        role: row.role,
        conversationId: row.conversation_id,
      },
    })),
  };
}

function searchWithFts(
  ftsMatch: string,
  memoryScopeId: string,
  limit: number,
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
      AND c.memory_scope_id = ?
      AND c.conversation_type != 'private'
      AND (c.source IS NULL OR c.source NOT IN (?, ?))
    ORDER BY bm25(messages_fts), m.created_at DESC
    LIMIT ?
    `,
    ftsMatch,
    memoryScopeId,
    SUBAGENT_SOURCE,
    AUTO_ANALYSIS_SOURCE,
    limit,
  );
}

function searchWithLike(
  query: string,
  memoryScopeId: string,
  limit: number,
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
      AND c.memory_scope_id = ?
      AND c.conversation_type != 'private'
      AND (c.source IS NULL OR c.source NOT IN (?, ?))
    ORDER BY m.created_at DESC
    LIMIT ?
    `,
    buildLikePattern(query),
    memoryScopeId,
    SUBAGENT_SOURCE,
    AUTO_ANALYSIS_SOURCE,
    limit,
  );
}

function buildLikePattern(query: string): string {
  return `%${query
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")}%`;
}
