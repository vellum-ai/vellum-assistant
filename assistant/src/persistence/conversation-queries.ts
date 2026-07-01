import { and, count, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { getMessagesSearchBackend } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import {
  parseExternalContentEnvelope,
  type UntrustedContentSource,
  unwrapExternalContentForDisplay,
  wrapUntrustedContent,
} from "../security/untrusted-content.js";
import { getLogger } from "../util/logger.js";
import type { ConversationRow } from "./conversation-crud.js";
import { parseConversation } from "./conversation-crud.js";
import { ensureDisplayOrderMigration } from "./conversation-display-order-migration.js";
import { ensureGroupMigration } from "./conversation-group-migration.js";
import { searchMessageIdsLexical } from "./conversation-search-lexical.js";
import type { ConversationType } from "./conversation-types.js";
import { getDb } from "./db-connection.js";
import { rawAll } from "./raw-query.js";
import { conversations, messages } from "./schema/index.js";

const log = getLogger("conversation-store");

/**
 * Build an FTS5 MATCH query string from natural text by extracting tokens.
 * Used for messages_fts full-text search over conversation content.
 */
export function buildFtsMatchQuery(
  text: string,
  opts?: { allowFts5Syntax?: boolean },
): string | null {
  // If the query already contains FTS5 operators, pass it through directly
  // so callers (e.g. the archive recall tool) can use exact-phrase, AND, OR,
  // NOT, NEAR syntax. Only enabled when the caller explicitly opts in —
  // user-facing search should always go through normal tokenization to avoid
  // FTS5 boolean semantics leaking into sidebar/global search.
  if (
    opts?.allowFts5Syntax &&
    /\bAND\b|\bOR\b|\bNOT\b|\bNEAR\s*\(|"[^"]+"/.test(text)
  ) {
    return text.trim();
  }

  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  if (tokens.length === 0) return null;
  const unique = [...new Set(tokens)].slice(0, 24);
  // Space-separated quoted tokens are implicit AND in FTS5.
  return unique.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ");
}

/**
 * How {@link listConversations} (and friends) treats archived rows.
 *
 * - `"active"` — exclude rows with a non-null `archivedAt`. The default
 *   for sidebar lists, restore, CLI pickers, and anything user-facing.
 * - `"archived"` — return ONLY archived rows. Powers the Archive page
 *   so it does not have to pull the entire conversation history and
 *   filter client-side.
 * - `"all"` — include both. Reserved for migrations and back-compat
 *   call sites that genuinely want everything in one query.
 */
export type ArchiveStatusFilter = "active" | "archived" | "all";

function archiveStatusClause(status: ArchiveStatusFilter) {
  switch (status) {
    case "active":
      return sql`${conversations.archivedAt} IS NULL`;
    case "archived":
      return sql`${conversations.archivedAt} IS NOT NULL`;
    case "all":
      return null;
  }
}

/**
 * Raw SQL predicate for "visible in the standard (Recents) listing".
 *
 * Shared by the `"standard"` bucket of {@link conversationTypeClause} (list +
 * count) and by every match path in {@link searchConversations} (FTS content,
 * LIKE content fallback, and title LIKE) so the listing and search can never
 * drift: anything the sidebar shows in Recents is also findable by search,
 * and vice versa.
 *
 * Two arms:
 * - Foreground rows: not background/scheduled/private by type, and not routed
 *   to the `system:background` / `system:scheduled` groups.
 * - Surfaced rows (`surfaced_at IS NOT NULL`): background/scheduled rows
 *   explicitly promoted via the surface API. Private rows stay excluded
 *   unconditionally, and subagent runs are excluded from the surfaced arm so
 *   they can never reach the sidebar.
 *
 * @param alias Table name or alias qualifying the column references
 *              (e.g. `"c"` in the search joins).
 */
function standardListingVisibilitySql(alias = "conversations"): string {
  return (
    `((${alias}.conversation_type NOT IN ('background', 'scheduled', 'private')` +
    ` AND COALESCE(${alias}.group_id, 'system:all') NOT IN ('system:background', 'system:scheduled'))` +
    ` OR ${surfacedVisibilitySql(alias)})`
  );
}

/**
 * Raw SQL predicate for the surfaced arm of standard-listing visibility:
 * background/scheduled rows explicitly promoted via the surface API
 * (`surfaced_at IS NOT NULL`), with private rows excluded unconditionally and
 * subagent runs excluded so they can never reach the sidebar.
 *
 * Shared by {@link standardListingVisibilitySql} and
 * {@link listPinnedConversations} so pinned surfaced rows stay visible
 * everywhere the standard listing would show them.
 */
function surfacedVisibilitySql(alias = "conversations"): string {
  return (
    `(${alias}.surfaced_at IS NOT NULL` +
    ` AND ${alias}.conversation_type != 'private'` +
    ` AND (${alias}.source IS NULL OR ${alias}.source != 'subagent'))`
  );
}

/**
 * SQL predicate selecting which bucket {@link listConversations} and
 * {@link countConversations} return, keyed by the canonical
 * {@link ConversationType}:
 *
 * - `"standard"` — the primary sidebar list: standard conversations only,
 *   excluding background, scheduled, and private rows. `"private"` is excluded
 *   defensively because in-place snapshot restore swaps the SQLite file without
 *   running migrations in-process, so legacy private rows can briefly exist
 *   before migration cleanup deletes them. Background/scheduled rows with a
 *   non-null `surfaced_at` (explicitly promoted via the surface API) are
 *   included so clients can render them in the Recents grouping without a
 *   separate fetch.
 * - `"background"` — the background **umbrella**: background *and* scheduled
 *   rows together. The back-compat bucket for the single
 *   `conversationType=background` fetch that older clients (e.g. the macOS app,
 *   which ships out of lockstep with the daemon) rely on to populate both the
 *   Background and Scheduled sidebar sections from one request.
 * - `"scheduled"` — scheduled rows only, so the Scheduled section can load
 *   independently of the broader background backlog without over-fetching it.
 *
 * `group_id` is matched alongside `conversationType` so conversations routed to
 * `system:background` / `system:scheduled` (heartbeat, reminders, schedule-job
 * runs) but created with conversationType `"standard"` still land in the
 * correct bucket. Subagent runs are excluded from the background/scheduled
 * buckets so the sidebar never surfaces them.
 */
function conversationTypeClause(type: ConversationType) {
  const notSubagent = sql`(${conversations.source} IS NULL OR ${conversations.source} != 'subagent')`;
  switch (type) {
    case "standard":
      // Surfaced rows (`surfaced_at IS NOT NULL`) are promoted into the
      // standard listing even when they're background/scheduled — see
      // standardListingVisibilitySql for the full predicate semantics.
      return sql.raw(standardListingVisibilitySql());
    case "background":
      return sql`(${conversations.conversationType} IN ('background', 'scheduled') OR group_id IN ('system:background', 'system:scheduled')) AND ${notSubagent}`;
    case "scheduled":
      return sql`(${conversations.conversationType} = 'scheduled' OR group_id = 'system:scheduled') AND ${notSubagent}`;
  }
}

export function listConversations(
  limit?: number,
  conversationType: ConversationType = "standard",
  offset = 0,
  archiveStatus: ArchiveStatusFilter = "active",
  originChannel?: string,
): ConversationRow[] {
  ensureDisplayOrderMigration();
  ensureGroupMigration();
  const db = getDb();
  const typeCond = conversationTypeClause(conversationType);
  const archiveCond = archiveStatusClause(archiveStatus);
  const channelCond = originChannel
    ? eq(conversations.originChannel, originChannel)
    : undefined;
  const where = and(typeCond, archiveCond ?? undefined, channelCond);
  const query = db
    .select()
    .from(conversations)
    .where(where)
    .orderBy(
      desc(
        sql`COALESCE(${conversations.lastMessageAt}, ${conversations.updatedAt})`,
      ),
    )
    .limit(limit ?? 100)
    .offset(offset);
  return query.all().map(parseConversation);
}

/**
 * List conversations matching an exact `source` value, ordered by `createdAt`
 * descending. The surgical filter for "find every background run produced by
 * job X" — heartbeat, memory_v2_consolidation, watcher-engine, etc. — since
 * `source` is the canonical job-class distinguisher across the background
 * bucket. `conversationType` + `group_id` only narrow to "background vs
 * scheduled vs standard"; neither identifies which job produced the row.
 *
 * Filter is exact (no `LIKE`, no implicit exclusions): the route layer is
 * responsible for knowing which source constants exist and passing one. The
 * defensive `source != 'subagent'` carve-out applied by `listConversations`
 * is deliberately NOT replicated here — a caller asking for an exact source
 * gets exactly that source.
 *
 * @param source        Exact match against `conversations.source`. Pass the
 *                      canonical constant (e.g. `MEMORY_V2_CONSOLIDATION_SOURCE`).
 * @param limit         Maximum rows to return (default 20).
 * @param opts.includeArchived  Include rows with non-null `archivedAt`.
 *                              Defaults to `true` so callers that want a full
 *                              run history get one; pass `false` for views
 *                              that hide archived rows.
 * @param opts.beforeCreatedAt  Only return rows with `createdAt` strictly
 *                              older than this epoch-millis cursor (for
 *                              paginating into history).
 */
export function listConversationsBySource(
  source: string,
  limit = 20,
  opts?: { includeArchived?: boolean; beforeCreatedAt?: number },
): ConversationRow[] {
  const db = getDb();
  const includeArchived = opts?.includeArchived ?? true;
  const where = and(
    eq(conversations.source, source),
    includeArchived ? undefined : isNull(conversations.archivedAt),
    opts?.beforeCreatedAt != null
      ? lt(conversations.createdAt, opts.beforeCreatedAt)
      : undefined,
  );
  const rows = db
    .select()
    .from(conversations)
    .where(where)
    .orderBy(desc(conversations.createdAt))
    .limit(limit)
    .all();
  return rows.map(parseConversation);
}

/**
 * Per-conversation aggregate of messages with a specific role. Powers
 * heartbeat-shaped run endpoints (e.g. `consolidation/runs`) that need a
 * "did the agent emit any output?" signal stronger than
 * `conversations.lastMessageAt` — which is bumped by the kickoff user
 * prompt and so cannot distinguish "agent ran" from "agent dispatched but
 * crashed before responding".
 *
 * Single batched aggregate query (no N+1). Conversations with zero matching
 * messages are NOT present in the returned map — callers should treat a
 * missing key as `{ count: 0, lastAt: null }`.
 *
 * @param conversationIds  Conversation ids to look up (empty → empty map).
 * @param role             Message role to count (default `"assistant"`).
 */
export function getMessageRoleStatsByConversation(
  conversationIds: string[],
  role: string = "assistant",
): Map<string, { count: number; lastAt: number }> {
  if (conversationIds.length === 0) return new Map();
  const db = getDb();
  const rows = db
    .select({
      conversationId: messages.conversationId,
      count: sql<number>`COUNT(*)`.as("count"),
      lastAt: sql<number>`MAX(${messages.createdAt})`.as("last_at"),
    })
    .from(messages)
    .where(
      and(
        inArray(messages.conversationId, conversationIds),
        eq(messages.role, role),
      ),
    )
    .groupBy(messages.conversationId)
    .all();
  return new Map(
    rows.map((r) => [
      r.conversationId,
      { count: Number(r.count), lastAt: Number(r.lastAt) },
    ]),
  );
}

export function listPinnedConversations(
  archiveStatus: ArchiveStatusFilter = "active",
): ConversationRow[] {
  ensureDisplayOrderMigration();
  ensureGroupMigration();
  const db = getDb();
  const archiveCond = archiveStatusClause(archiveStatus);
  const query = db
    .select()
    .from(conversations)
    .where(
      and(
        // Mirror the standard listing: plain foreground rows by type, plus
        // surfaced background/scheduled rows — a pinned surfaced conversation
        // must stay injectable into page 1 (see surfacedVisibilitySql).
        sql.raw(
          `(conversations.conversation_type NOT IN ('background', 'scheduled', 'private')` +
            ` OR ${surfacedVisibilitySql()})`,
        ),
        sql`is_pinned = 1`,
        ...(archiveCond ? [archiveCond] : []),
      ),
    )
    .orderBy(
      sql`COALESCE(display_order, 999999) ASC`,
      desc(
        sql`COALESCE(${conversations.lastMessageAt}, ${conversations.updatedAt})`,
      ),
    );
  return query.all().map(parseConversation);
}

/**
 * Row shape returned by {@link listConversationsByTitlePrefix}.
 *
 * Kept deliberately narrow (no full `ConversationRow`) since the only caller
 * today is the playground's seeded-conversation listing endpoint, which only
 * needs display metadata plus a message count to show in a list.
 */
export interface ConversationTitlePrefixRow {
  id: string;
  title: string;
  messageCount: number;
  createdAt: number;
}

/**
 * List non-archived conversations whose `title` begins with `prefix`.
 *
 * Uses raw SQL with a subquery for `messageCount` so a single round-trip
 * returns everything the caller needs. The `LIKE ? || '%'` pattern does a
 * prefix match; SQLite optimizes this with an index when one exists on
 * `title`, otherwise it degrades to a table scan — acceptable for the
 * playground-seeded set, which is small by construction.
 *
 * Escaping is unnecessary here because the prefix is a build-time constant
 * (`PLAYGROUND_TITLE_PREFIX`) rather than user input. If callers ever pass
 * dynamic prefixes, switch to `ESCAPE '\\'` and pre-escape `%` / `_` / `\`.
 */
export function listConversationsByTitlePrefix(
  prefix: string,
): ConversationTitlePrefixRow[] {
  interface Row {
    id: string;
    title: string;
    message_count: number;
    created_at: number;
  }
  const rows = rawAll<Row>(
    `SELECT c.id, c.title,
            (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS message_count,
            c.created_at
     FROM conversations c
     WHERE c.title LIKE ? || '%' AND c.archived_at IS NULL
     ORDER BY c.created_at DESC`,
    prefix,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    messageCount: r.message_count,
    createdAt: r.created_at,
  }));
}

export function countConversations(
  conversationType: ConversationType = "standard",
  archiveStatus: ArchiveStatusFilter = "active",
  originChannel?: string,
): number {
  ensureGroupMigration();
  const db = getDb();
  const typeCond = conversationTypeClause(conversationType);
  const archiveCond = archiveStatusClause(archiveStatus);
  const channelCond = originChannel
    ? eq(conversations.originChannel, originChannel)
    : undefined;
  const where = and(typeCond, archiveCond ?? undefined, channelCond);
  const [{ total }] = db
    .select({ total: count() })
    .from(conversations)
    .where(where)
    .all();
  return total;
}

/**
 * Check whether the last user message in a conversation is a tool_result-only
 * message (i.e., not a real user-typed message). This is used by undo() to
 * determine if additional exchanges need to be deleted from the DB.
 */
export function isLastUserMessageToolResult(conversationId: string): boolean {
  const db = getDb();
  const lastUserMsg = db
    .select({ content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.role, "user"),
      ),
    )
    .orderBy(sql`rowid DESC`)
    .limit(1)
    .get();

  if (!lastUserMsg) return false;

  try {
    const parsed = JSON.parse(lastUserMsg.content);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (block: Record<string, unknown>) =>
          block.type === "tool_result" ||
          block.type === "web_search_tool_result" ||
          (block.type === "text" &&
            typeof block.text === "string" &&
            block.text.startsWith("<system_notice>") &&
            block.text.endsWith("</system_notice>")),
      )
    ) {
      return true;
    }
  } catch {
    // Not JSON — it's a plain text user message
  }
  return false;
}

export interface ConversationSearchResult {
  conversationId: string;
  conversationTitle: string | null;
  conversationUpdatedAt: number;
  matchingMessages: Array<{
    messageId: string;
    role: string;
    /** Plain-text excerpt around the match, truncated to ~200 chars. */
    excerpt: string;
    createdAt: number;
  }>;
}

interface ConversationSearchMsgRow {
  id: string;
  role: string;
  content: string;
  created_at: number;
}

/**
 * SQL `LIKE` pattern escaping the three wildcard metacharacters (`\`, `%`, `_`)
 * so a literal user query matches as literal text under `ESCAPE '\\'`. Wrapped
 * in `%...%` for a substring match.
 */
function likeContainsPattern(query: string): string {
  return `%${query
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")}%`;
}

/**
 * Collect visible, non-archived conversation ids whose message content matches
 * `query` via a `messages.content LIKE` substring scan. Shared by the
 * non-tokenizable-query path (both backends) and the Qdrant error-degrade path.
 */
function likeContentMatchConvIds(query: string): string[] {
  interface ConvIdRow {
    conversation_id: string;
  }
  const rows = rawAll<ConvIdRow>(
    `
    SELECT DISTINCT m.conversation_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.content LIKE ? ESCAPE '\\' AND ${standardListingVisibilitySql("c")} AND c.archived_at IS NULL
    LIMIT 1000
  `,
    likeContainsPattern(query),
  );
  return rows.map((r) => r.conversation_id);
}

/**
 * Per-conversation top messages matching `query` by `content LIKE` substring,
 * ordered oldest-first and capped at `limit`. The `messages.content LIKE`
 * fallback used when there are no lexical tokens or Qdrant is unavailable.
 */
function likeContentMatchMessages(
  conversationId: string,
  query: string,
  limit: number,
): ConversationSearchMsgRow[] {
  return rawAll<ConversationSearchMsgRow>(
    `
    SELECT id, role, content, created_at
    FROM messages
    WHERE conversation_id = ? AND content LIKE ? ESCAPE '\\'
    ORDER BY created_at ASC
    LIMIT ?
  `,
    conversationId,
    likeContainsPattern(query),
    limit,
  );
}

/**
 * Full-text search across message content.
 *
 * The lexical backend is selected by the `messages-search-backend` feature
 * flag (see {@link getMessagesSearchBackend}):
 *   - `fts5` (default): the `messages_fts` virtual table for tokenized matching.
 *   - `qdrant`: the sparse `messages_lexical` Qdrant index (BM25-style).
 * Both apply the same visibility/archived SQL filtering, merge with a `LIKE`
 * match on conversation titles, and return matching conversations with their
 * relevant messages ordered by most recently updated.
 *
 * A query that tokenizes to nothing under the shared tokenizer (non-ASCII or
 * single-char input like "你", "é", "C++") falls back to a `messages.content
 * LIKE` scan for both backends. If the Qdrant lexical lookup throws, the search
 * degrades to that same `LIKE` scan.
 */
export async function searchConversations(
  query: string,
  opts?: { limit?: number; maxMessagesPerConversation?: number },
): Promise<ConversationSearchResult[]> {
  if (!query.trim()) return [];

  ensureGroupMigration();
  const db = getDb();
  const trimmed = query.trim();
  const limit = opts?.limit ?? 20;
  const maxMsgsPerConv = opts?.maxMessagesPerConversation ?? 3;

  const ftsMatch = buildFtsMatchQuery(trimmed);
  const backend = getMessagesSearchBackend(getConfig());

  // LIKE pattern for title matching (message-content indexes don't cover titles).
  const titlePattern = likeContainsPattern(query);

  // Collect conversation IDs from message-content matches and title LIKE
  // matches, then merge them to produce the final set of matching
  // conversations. Content paths LIMIT on distinct conversation_id to prevent a
  // single conversation with many matching messages from crowding out others.
  const contentConvIds = new Set<string>();

  // When the Qdrant backend answers, `qdrantCandidatesByConv` maps each
  // conversation to its candidate message ids so the per-conversation message
  // fetch reuses the single lexical round-trip instead of issuing a second one.
  // `qdrantDegraded` records a lexical-lookup failure so the per-conversation
  // fetch mirrors the conv-id collection and falls back to the LIKE scan.
  let qdrantCandidatesByConv: Map<string, string[]> | null = null;
  let qdrantDegraded = false;

  if (ftsMatch && backend === "qdrant") {
    let candidates: Awaited<ReturnType<typeof searchMessageIdsLexical>> = [];
    try {
      candidates = await searchMessageIdsLexical(trimmed, 1000);
    } catch (err) {
      qdrantDegraded = true;
      log.warn(
        { err, query: query.slice(0, 80) },
        "searchConversations: Qdrant lexical query failed — falling back to LIKE content match",
      );
    }

    if (qdrantDegraded) {
      for (const id of likeContentMatchConvIds(query)) contentConvIds.add(id);
    } else if (candidates.length > 0) {
      const candidateIds = candidates.map((c) => c.messageId);
      // Filter the lexical candidates down to visible, non-archived
      // conversations in SQL (Qdrant has no visibility filtering), then group
      // the surviving candidate message ids by conversation for reuse below.
      interface CandidateRow {
        id: string;
        conversation_id: string;
      }
      const placeholders = candidateIds.map(() => "?").join(",");
      const visibleRows = rawAll<CandidateRow>(
        `
        SELECT DISTINCT m.id, m.conversation_id
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id IN (${placeholders}) AND ${standardListingVisibilitySql("c")} AND c.archived_at IS NULL
        LIMIT 1000
      `,
        ...candidateIds,
      );
      qdrantCandidatesByConv = new Map();
      for (const row of visibleRows) {
        contentConvIds.add(row.conversation_id);
        const bucket = qdrantCandidatesByConv.get(row.conversation_id);
        if (bucket) bucket.push(row.id);
        else qdrantCandidatesByConv.set(row.conversation_id, [row.id]);
      }
    }
  } else if (ftsMatch) {
    try {
      interface ConvIdRow {
        conversation_id: string;
      }
      const ftsRows = rawAll<ConvIdRow>(
        `
        SELECT DISTINCT m.conversation_id
        FROM messages_fts f
        JOIN messages m ON m.id = f.message_id
        JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ? AND ${standardListingVisibilitySql("c")} AND c.archived_at IS NULL
        LIMIT 1000
      `,
        ftsMatch,
      );
      for (const row of ftsRows) contentConvIds.add(row.conversation_id);
    } catch (err) {
      log.warn(
        { err, query: query.slice(0, 80) },
        "searchConversations: FTS query failed — falling through to title matches",
      );
    }
  } else {
    // The query tokenized to nothing (non-ASCII, single-char, etc.) — fall back
    // to a LIKE-based message content search so queries like "你", "é", or
    // "C++" still match message text.
    for (const id of likeContentMatchConvIds(query)) contentConvIds.add(id);
  }

  // Title-only matches (message-content indexes don't cover conversation titles).
  const titleMatchConvs = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        sql.raw(standardListingVisibilitySql()),
        sql`${conversations.title} LIKE ${titlePattern} ESCAPE '\\'`,
        sql`${conversations.archivedAt} IS NULL`,
      ),
    )
    .all();
  for (const row of titleMatchConvs) contentConvIds.add(row.id);

  if (contentConvIds.size === 0) return [];

  // Fetch the matching conversation rows, ordered by updatedAt, capped at limit.
  const convIds = [...contentConvIds];
  const placeholders = convIds.map(() => "?").join(",");
  interface ConvRow {
    id: string;
    title: string | null;
    updated_at: number;
  }
  const matchingConversations = rawAll<ConvRow>(
    `SELECT id, title, updated_at FROM conversations
     WHERE id IN (${placeholders})
     ORDER BY updated_at DESC
     LIMIT ?`,
    ...convIds,
    limit,
  );

  if (matchingConversations.length === 0) return [];

  const results: ConversationSearchResult[] = [];

  for (const conv of matchingConversations) {
    let matchingMsgs: ConversationSearchMsgRow[] = [];
    if (ftsMatch && backend === "qdrant" && !qdrantDegraded) {
      // Reuse the lexical candidates already fetched above — no second Qdrant
      // round-trip. Select this conversation's candidate message rows by id,
      // ordered oldest-first to match the FTS path.
      const candidateIds = qdrantCandidatesByConv?.get(conv.id) ?? [];
      if (candidateIds.length > 0) {
        const msgPlaceholders = candidateIds.map(() => "?").join(",");
        matchingMsgs = rawAll<ConversationSearchMsgRow>(
          `
          SELECT id, role, content, created_at
          FROM messages
          WHERE conversation_id = ? AND id IN (${msgPlaceholders})
          ORDER BY created_at ASC
          LIMIT ?
        `,
          conv.id,
          ...candidateIds,
          maxMsgsPerConv,
        );
      }
    } else if (ftsMatch && backend !== "qdrant") {
      try {
        matchingMsgs = rawAll<ConversationSearchMsgRow>(
          `
          SELECT m.id, m.role, m.content, m.created_at
          FROM messages_fts f
          JOIN messages m ON m.id = f.message_id
          WHERE messages_fts MATCH ? AND m.conversation_id = ?
          ORDER BY m.created_at ASC
          LIMIT ?
        `,
          ftsMatch,
          conv.id,
          maxMsgsPerConv,
        );
      } catch (err) {
        log.warn(
          { err, conversationId: conv.id },
          "searchConversations: FTS per-conversation query failed",
        );
      }
    } else {
      // No lexical tokens, or the Qdrant lookup degraded — LIKE fallback for
      // non-ASCII / short-token queries and the Qdrant-error path.
      matchingMsgs = likeContentMatchMessages(conv.id, query, maxMsgsPerConv);
    }

    results.push({
      conversationId: conv.id,
      conversationTitle: conv.title,
      conversationUpdatedAt: conv.updated_at,
      matchingMessages: matchingMsgs.map((m) => ({
        messageId: m.id,
        role: m.role,
        excerpt: buildExcerpt(m.content, query),
        createdAt: m.created_at,
      })),
    });
  }

  return results;
}

/**
 * Build a short excerpt from raw message content centered around the first
 * occurrence of `query`. The content may be JSON (content blocks) or plain
 * text; we extract a readable snippet in either case.
 */
export function buildExcerpt(rawContent: string, query: string): string {
  return buildExcerptWithExternalContentMode(rawContent, query, "display");
}

/**
 * Build an excerpt for model-facing recall evidence. Unlike display excerpts,
 * this keeps complete external_content envelopes around untrusted snippets so
 * the model still sees clear third-party content boundaries.
 */
export function buildRecallEvidenceExcerpt(
  rawContent: string,
  query: string,
): string {
  return buildExcerptWithExternalContentMode(rawContent, query, "preserve");
}

function buildExcerptWithExternalContentMode(
  rawContent: string,
  query: string,
  externalContentMode: "display" | "preserve",
): string {
  // Try to extract plain text from JSON content blocks first.
  let text = rawContent;
  try {
    const parsed = JSON.parse(rawContent);
    if (Array.isArray(parsed)) {
      const parts: string[] = [];
      let preservedExternalContent = false;
      for (const block of parsed) {
        if (typeof block === "object" && block != null) {
          if (block.type === "text" && typeof block.text === "string") {
            if (externalContentMode === "display") {
              parts.push(unwrapExternalContentForDisplay(block.text));
            } else {
              const excerpt = buildRecallEvidenceText(block.text, query);
              parts.push(excerpt.text);
              preservedExternalContent ||= excerpt.preservedExternalContent;
            }
          } else if (
            block.type === "tool_result" ||
            block.type === "web_search_tool_result"
          ) {
            const inner = Array.isArray(block.content) ? block.content : [];
            for (const ib of inner) {
              if (ib?.type === "text" && typeof ib.text === "string") {
                if (externalContentMode === "display") {
                  parts.push(unwrapExternalContentForDisplay(ib.text));
                } else {
                  const excerpt = buildRecallEvidenceText(ib.text, query);
                  parts.push(excerpt.text);
                  preservedExternalContent ||= excerpt.preservedExternalContent;
                }
              }
            }
          }
        }
      }
      if (parts.length > 0) {
        text = parts.join(" ");
        if (externalContentMode === "preserve" && preservedExternalContent) {
          return text;
        }
      }
    } else if (typeof parsed === "string") {
      text = parsed;
    }
  } catch {
    // Not JSON — use as-is
  }

  if (externalContentMode === "display") {
    text = unwrapExternalContentForDisplay(text);
  } else {
    const envelope = parseExternalContentEnvelope(text);
    if (envelope) {
      const innerExcerpt = buildExcerptFromText(envelope.content, query);
      return wrapRecallEvidenceExcerpt(
        innerExcerpt,
        envelope.source,
        envelope.origin,
      );
    }
  }

  return buildExcerptFromText(text, query);
}

function buildRecallEvidenceText(
  text: string,
  query: string,
): { text: string; preservedExternalContent: boolean } {
  const envelope = parseExternalContentEnvelope(text);
  if (!envelope) {
    return { text, preservedExternalContent: false };
  }
  const innerExcerpt = buildExcerptFromText(envelope.content, query);
  return {
    text: wrapRecallEvidenceExcerpt(
      innerExcerpt,
      envelope.source,
      envelope.origin,
    ),
    preservedExternalContent: true,
  };
}

function wrapRecallEvidenceExcerpt(
  excerpt: string,
  source: UntrustedContentSource,
  origin?: string,
): string {
  return origin
    ? wrapUntrustedContent(excerpt, { source, sourceDetail: origin })
    : wrapUntrustedContent(excerpt, { source });
}

function buildExcerptFromText(text: string, query: string): string {
  const WINDOW = 100;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) {
    // Query matched the raw JSON but not the extracted text — fall back to raw start
    return text
      .slice(0, WINDOW * 2)
      .replace(/\s+/g, " ")
      .trim();
  }
  const start = Math.max(0, idx - WINDOW);
  const end = Math.min(text.length, idx + query.length + WINDOW);
  const excerpt =
    (start > 0 ? "\u2026" : "") +
    text.slice(start, end).replace(/\s+/g, " ").trim() +
    (end < text.length ? "\u2026" : "");
  return excerpt;
}
