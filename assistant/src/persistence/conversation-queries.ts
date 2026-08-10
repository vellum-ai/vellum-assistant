import { and, count, desc, eq, isNull, lt, sql } from "drizzle-orm";

import {
  parseExternalContentEnvelope,
  type UntrustedContentSource,
  unwrapExternalContentForDisplay,
  wrapUntrustedContent,
} from "../security/untrusted-content.js";
import { getLogger } from "../util/logger.js";
import { isLexicalBackfillComplete } from "./checkpoints.js";
import { unseenAttentionStateConditions } from "./conversation-attention-store.js";
import type { ConversationRow } from "./conversation-crud.js";
import { parseConversation } from "./conversation-crud.js";
import { ensureDisplayOrderMigration } from "./conversation-display-order-migration.js";
import { ensureGroupMigration } from "./conversation-group-migration.js";
import { searchMessageIdsLexical } from "./conversation-search-lexical.js";
import {
  type ConversationType,
  NATIVE_ORIGIN_CHANNEL,
  PINNED_GROUP_ID,
  UNGROUPED_GROUP_ID,
} from "./conversation-types.js";
import { getDb } from "./db-connection.js";
import { tokenize } from "./embeddings/sparse-tokenize.js";
import {
  parseContentRef,
  resolveMessageContentBlocks,
} from "./message-content-file.js";
import {
  countMessagesByRoleForConversations,
  latestUserMessageRawContent,
} from "./message-reads.js";
import { rawAll } from "./raw-query.js";
import {
  conversationAssistantAttentionState,
  conversations,
} from "./schema/index.js";

const log = getLogger("conversation-store");

/**
 * Max distinct visible conversations {@link searchConversations} collects from
 * content matches before merging with title matches and the final
 * `updated_at`-ordered `LIMIT`. Both backends cap on distinct conversations (not
 * matching messages) so one chatty conversation can't crowd others out; the FTS
 * path enforces this in SQL (`SELECT DISTINCT conversation_id … LIMIT`).
 */
const CONVERSATION_SEARCH_DISTINCT_LIMIT = 1000;

/**
 * Message-candidate over-fetch for the Qdrant lexical backend.
 *
 * Qdrant ranks at message grain and has no visibility/archived filtering, so a
 * naive cap at {@link CONVERSATION_SEARCH_DISTINCT_LIMIT} *messages* could be
 * consumed entirely by one chatty visible conversation or by private/archived
 * candidates, starving other matching visible conversations — unlike the FTS
 * path, which caps on distinct conversations *after* the visibility JOIN.
 *
 * To approximate that behavior we over-fetch this many message candidates, then
 * filter/dedupe to distinct visible conversations in code, so the effective cap
 * lands on {@link CONVERSATION_SEARCH_DISTINCT_LIMIT} distinct visible
 * conversations. A few thousand candidates reliably yields far more than the
 * caller's `limit` (default 20) distinct visible conversations except in
 * pathological mega-conversation cases.
 *
 * This is a proportionate over-fetch, NOT a hard parity guarantee: a query
 * whose top ~{@link QDRANT_SEARCH_CANDIDATE_LIMIT} candidates all fall in a
 * handful of conversations can still under-surface. The stronger fix — Qdrant
 * `search_groups` (group_by `conversation_id`) or true score-ordered
 * pagination — is deferred to pre-flip hardening if Gate A shows regressions.
 *
 * Kept well under bun:sqlite's ~32k bound-parameter ceiling so the
 * `WHERE m.id IN (…)` visibility query stays a single statement.
 */
const QDRANT_SEARCH_CANDIDATE_LIMIT = 5000;

/**
 * Whether `text` yields at least one usable lexical token (≥2 chars of
 * `[a-z0-9_]`). Queries with none — non-ASCII, single-char, or
 * punctuation-only input like "你", "é", "C++" — cannot be served by content
 * matching: the sparse encoder would still emit noisy 1-char tokens for them,
 * so the read sites skip the lexical index entirely and fall back to their
 * no-token behavior (title matches only / no evidence).
 */
export function hasLexicalTokens(text: string): boolean {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .some((token) => token.trim().length >= 2);
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
 * Three arms:
 * - Foreground rows: not background/scheduled/private by type, and not routed
 *   to the `system:background` / `system:scheduled` groups.
 * - Surfaced rows (`surfaced_at IS NOT NULL`): background/scheduled rows
 *   explicitly promoted via the surface API. Private rows stay excluded
 *   unconditionally, and subagent runs are excluded from the surfaced arm so
 *   they can never reach the sidebar.
 * - Custom-group rows: rows filed into a user-created group (a non-`system:`
 *   `group_id`), regardless of conversation type. Filing is an explicit
 *   organizational action (the web "Move to group" menu, the
 *   conversation-groups skill, or a schedule's configured group), so the row
 *   must render inside that group on a cold sidebar load. Same
 *   private/subagent exclusions as the surfaced arm.
 *
 * @param alias Table name or alias qualifying the column references
 *              (e.g. `"c"` in the search joins).
 */
function standardListingVisibilitySql(alias = "conversations"): string {
  return (
    `((${alias}.conversation_type NOT IN ('background', 'scheduled', 'private')` +
    ` AND COALESCE(${alias}.group_id, 'system:all') NOT IN ('system:background', 'system:scheduled'))` +
    ` OR ${surfacedVisibilitySql(alias)}` +
    ` OR ${customGroupVisibilitySql(alias)})`
  );
}

/**
 * Raw SQL predicate for the custom-group arm of standard-listing visibility:
 * rows whose `group_id` names a user-created group (custom groups are UUIDs;
 * system groups use the `system:` prefix). Private rows are excluded
 * unconditionally and subagent runs are excluded so they can never reach the
 * sidebar, mirroring {@link surfacedVisibilitySql}.
 */
function customGroupVisibilitySql(alias = "conversations"): string {
  return (
    `(${alias}.group_id IS NOT NULL` +
    ` AND ${alias}.group_id NOT LIKE 'system:%'` +
    ` AND ${alias}.conversation_type != 'private'` +
    ` AND (${alias}.source IS NULL OR ${alias}.source != 'subagent'))`
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
 * Raw SQL predicate for "not an automated background/scheduled row".
 *
 * A background or scheduled row counts as foreground only once it has been
 * explicitly surfaced. {@link standardListingVisibilitySql} already admits
 * such rows through its surfaced and custom-group arms, so a caller that
 * must distinguish "visible in the listing" from "user-facing foreground"
 * (unread counting) applies this on top.
 *
 * The SQL twin of `isBackgroundConversation` in the web client's
 * `utils/conversation-predicates.ts`.
 */
function notBackgroundVisibilitySql(alias = "conversations"): string {
  return (
    `NOT ((${alias}.conversation_type IN ('background', 'scheduled')` +
    ` OR COALESCE(${alias}.group_id, 'system:all') IN ('system:background', 'system:scheduled'))` +
    ` AND ${alias}.surfaced_at IS NULL)`
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

/**
 * The predicates that select which conversations a listing covers, shared by
 * {@link listConversations} and {@link countConversations} so a list and its
 * count can never disagree about what they are describing.
 *
 * Named rather than positional on purpose: `originChannel` and `groupId` are
 * both optional strings, and as adjacent positional arguments they were a
 * transposition waiting to happen.
 */
export interface ConversationListFilter {
  conversationType?: ConversationType;
  archiveStatus?: ArchiveStatusFilter;
  originChannel?: string;
  /**
   * Restrict to one group. {@link UNGROUPED_GROUP_ID} selects rows in no
   * group (the sidebar's flat list), {@link PINNED_GROUP_ID} the Pinned
   * section, and a UUID one custom group. Omit to span every group.
   */
  groupId?: string;
}

export interface ConversationListQuery extends ConversationListFilter {
  limit?: number;
  offset?: number;
}

/**
 * SQL predicate for {@link ConversationListFilter.groupId}.
 *
 * The ungrouped case has to match NULL as well as the literal sentinel:
 * `group_id` is only written when a conversation is filed somewhere, so the
 * overwhelming majority of rows carry NULL rather than `'system:all'`.
 *
 * `group_id` is referenced as raw SQL because it is not a Drizzle column:
 * it, `display_order`, and `is_pinned` are added by the lazy
 * `ensureDisplayOrderMigration` / `ensureGroupMigration` steps rather than
 * declared in `schema/conversations.ts`.
 */
function groupIdClause(groupId: string) {
  if (groupId === UNGROUPED_GROUP_ID) {
    // "Ungrouped" means every row the sidebar's flat list shows: not pinned
    // and not filed in a custom group. It deliberately admits the system
    // buckets, because a surfaced background or scheduled conversation keeps
    // its `system:background` / `system:scheduled` group id (surfacing writes
    // only `surfaced_at`) while the standard listing renders it in Recents.
    // Whether such a row is actually visible stays with
    // `conversationTypeClause`, which admits the surfaced ones and excludes
    // the rest; matching on group id alone here would drop them.
    return sql`(group_id IS NULL OR (group_id LIKE 'system:%' AND group_id != ${PINNED_GROUP_ID}))`;
  }
  // `group_id` is single-valued and authoritative, so a row belongs to
  // exactly one section by construction. `is_pinned` is a derived duplicate
  // that reads do not consult: `ensureGroupMigration` backfills
  // `group_id = 'system:pinned'` for every legacy `is_pinned` row before any
  // query runs, and pinning writes both together thereafter.
  return sql`group_id = ${groupId}`;
}

/**
 * SQL predicate for {@link ConversationListFilter.originChannel}.
 *
 * `'vellum'` additionally matches NULL. `origin_channel` is left NULL at
 * insert precisely so an inbound message can still claim the conversation for
 * its channel (`setConversationOriginChannelIfUnset` is guarded on `isNull`),
 * and migration 288 settles whatever was never claimed to `'vellum'` at daemon
 * startup. NULL is therefore "not yet attributed", and it is what the
 * overwhelming majority of rows carry between one boot and the next.
 *
 * A strict equality would put those rows in no section at all: not native, not
 * any channel. Reading NULL as native is the self-correcting error of the two,
 * since the only rows it can misplace are ones whose inbound message has not
 * arrived yet, and that message moves them the moment it does.
 *
 * Every other channel matches exactly. A row is claimed for a channel only by
 * that channel, so there is no ambiguity to be tolerant about.
 */
function originChannelClause(originChannel: string) {
  if (originChannel === NATIVE_ORIGIN_CHANNEL) {
    return sql`(origin_channel IS NULL OR origin_channel = ${NATIVE_ORIGIN_CHANNEL})`;
  }
  return eq(conversations.originChannel, originChannel);
}

function conversationListWhere(filter: ConversationListFilter) {
  const {
    conversationType = "standard",
    archiveStatus = "active",
    originChannel,
    groupId,
  } = filter;
  return and(
    conversationTypeClause(conversationType),
    archiveStatusClause(archiveStatus) ?? undefined,
    originChannel ? originChannelClause(originChannel) : undefined,
    groupId ? groupIdClause(groupId) : undefined,
  );
}

export function listConversations(
  query: ConversationListQuery = {},
): ConversationRow[] {
  ensureDisplayOrderMigration();
  ensureGroupMigration();
  const db = getDb();
  const { limit, offset = 0, ...filter } = query;
  const recency = desc(
    sql`COALESCE(${conversations.lastMessageAt}, ${conversations.updatedAt})`,
  );
  // `id` closes the ordering so the sort is a total order. Rows tied on every
  // preceding key would otherwise have no defined relative order, which
  // becomes duplicated and skipped rows once a cursor pages across a tie
  // boundary.
  //
  // Deliberately untested here: SQLite returns a stable arrangement for
  // identical queries over identical data, so no assertion at this layer can
  // distinguish a total order from a lucky one. The guarantee becomes
  // observable, and gets its test, with the keyset pagination work.
  const tiebreak = desc(conversations.id);
  return db
    .select()
    .from(conversations)
    .where(conversationListWhere(filter))
    .orderBy(recency, tiebreak)
    .limit(limit ?? 100)
    .offset(offset)
    .all()
    .map(parseConversation);
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
  return countMessagesByRoleForConversations(conversationIds, role);
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
    "conversation:listByTitlePrefix",
    `SELECT c.id, c.title,
            -- Any-state count (streaming rows included): a list-surface size
            -- hint where a transient +1 during a live turn is immaterial.
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

/**
 * How many conversations {@link listConversations} would return for the same
 * filter, ignoring `limit` / `offset`. Both read through
 * {@link conversationListWhere}, so a page and its total always describe the
 * same set.
 */
export function countConversations(
  filter: ConversationListFilter = {},
): number {
  ensureGroupMigration();
  const db = getDb();
  const [{ total }] = db
    .select({ total: count() })
    .from(conversations)
    .where(conversationListWhere(filter))
    .all();
  return total;
}

/**
 * Count of foreground conversations whose latest assistant message is unseen.
 *
 * The server-side twin of the web client's `contributesToUnreadCount`
 * predicate (`clients/web/src/utils/conversation-predicates.ts`), so the
 * count returned by `GET /v1/conversations/unread-count` always matches what
 * the sidebar's unread indicators would sum to over the full list.
 *
 * **Two definitions of one rule.** Changing what counts here means changing
 * the client predicate too. Both sides assert the same named scenario matrix
 * ("unread-count contract") so a one-sided change is visible in review: see
 * `__tests__/conversation-list-routes.test.ts` here and
 * `conversation-predicates.test.ts` there. The duplication exists only to
 * keep a fallback for assistants without this route, and goes away with it.
 *
 * The rules:
 *
 * - visible in the standard (Recents) listing ({@link conversationTypeClause}),
 * - not archived,
 * - not an unsurfaced background/scheduled row
 *   ({@link notBackgroundVisibilitySql}), which excludes automated rows the
 *   listing admits through its custom-group arm,
 * - unseen per the attention projection
 *   ({@link unseenAttentionStateConditions}); conversations without a
 *   projection row read as seen, hence the inner join.
 */
export function countUnreadConversations(): number {
  ensureGroupMigration();
  const db = getDb();
  const [{ total }] = db
    .select({ total: count() })
    .from(conversations)
    .innerJoin(
      conversationAssistantAttentionState,
      eq(conversationAssistantAttentionState.conversationId, conversations.id),
    )
    .where(
      and(
        conversationTypeClause("standard"),
        isNull(conversations.archivedAt),
        sql.raw(notBackgroundVisibilitySql()),
        ...unseenAttentionStateConditions(),
      ),
    )
    .all();
  return total;
}

/** Totals for one sidebar section: every member, and the unread among them. */
export interface ConversationSectionCount {
  total: number;
  unread: number;
}

/**
 * Row counts for every non-empty sidebar section, with no rows fetched.
 *
 * Two axes, disjoint by construction because `group_id` is single-valued:
 *
 * - `groups`: rows filed somewhere, bucketed by `group_id`. Contains
 *   `'system:pinned'` and custom-group ids; the background/scheduled system
 *   buckets are excluded because no section renders them.
 * - `channels`: rows filed nowhere, bucketed by effective origin channel,
 *   where NULL reads as {@link NATIVE_ORIGIN_CHANNEL} exactly as
 *   {@link originChannelClause} reads it. The native bucket is the Chats
 *   section; each other bucket is that channel's section.
 *
 * Only buckets with at least one row appear: GROUP BY cannot emit an empty
 * bucket, and an empty section renders no card.
 *
 * `total` follows the standard-listing visibility
 * ({@link conversationTypeClause}), active rows only, so it counts exactly
 * the rows `GET /v1/conversations` would return for that section's filter.
 * `unread` applies the same rules as {@link countUnreadConversations} on top
 * (not an unsurfaced background/scheduled row, unseen per the attention
 * projection), composed from the same predicates rather than restated, so
 * the per-section numbers always sum against the global count.
 */
export interface ConversationSectionCounts {
  groups: Array<{ groupId: string } & ConversationSectionCount>;
  channels: Array<{ channel: string } & ConversationSectionCount>;
}

export function countConversationSections(): ConversationSectionCounts {
  ensureGroupMigration();
  const db = getDb();

  /* `countUnreadConversations` gets the same effect with an INNER JOIN and
     the unseen conditions in its WHERE; here every row must be counted and
     only unread rows summed, so the join is LEFT and the conditions move
     into the CASE. A row with no attention projection has NULL columns,
     fails the conditions, and sums 0: identical membership. */
  const unread = sql<number>`SUM(CASE WHEN ${and(
    sql.raw(notBackgroundVisibilitySql()),
    ...unseenAttentionStateConditions(),
  )} THEN 1 ELSE 0 END)`;

  const attentionJoin = eq(
    conversationAssistantAttentionState.conversationId,
    conversations.id,
  );

  const groups = db
    .select({
      groupId: sql<string>`group_id`,
      total: count(),
      unread,
    })
    .from(conversations)
    .leftJoin(conversationAssistantAttentionState, attentionJoin)
    .where(
      and(
        conversationTypeClause("standard"),
        isNull(conversations.archivedAt),
        sql`(group_id = ${PINNED_GROUP_ID} OR (group_id IS NOT NULL AND group_id NOT LIKE 'system:%'))`,
      ),
    )
    .groupBy(sql`group_id`)
    .all();

  const effectiveChannel = sql<string>`COALESCE(${conversations.originChannel}, ${NATIVE_ORIGIN_CHANNEL})`;
  const channels = db
    .select({
      channel: effectiveChannel,
      total: count(),
      unread,
    })
    .from(conversations)
    .leftJoin(conversationAssistantAttentionState, attentionJoin)
    .where(
      and(
        conversationTypeClause("standard"),
        isNull(conversations.archivedAt),
        groupIdClause(UNGROUPED_GROUP_ID),
      ),
    )
    .groupBy(effectiveChannel)
    .all();

  return { groups, channels };
}

/**
 * Check whether the last user message in a conversation is a tool_result-only
 * message (i.e., not a real user-typed message). This is used by undo() to
 * determine if additional exchanges need to be deleted from the DB.
 */
export function isLastUserMessageToolResult(conversationId: string): boolean {
  const lastUserContent = latestUserMessageRawContent(conversationId);

  if (lastUserContent === null) {
    return false;
  }

  try {
    const parsed = JSON.parse(lastUserContent);
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
 * Whether the sparse Qdrant `messages_lexical` index — the only source of
 * message-content matches — is a safe read source. Content matching is
 * unavailable (title matches only) until the one-time upgrade backfill has
 * fully drained: a partially populated collection would silently miss older
 * content (an empty result — not a throw). Indexing itself is unconditional
 * host infrastructure, so completion is the only gate; the recall read site
 * applies the same one via the shared {@link isLexicalBackfillComplete}.
 */
function isMessageContentSearchAvailable(): boolean {
  return isLexicalBackfillComplete();
}

/**
 * Full-text search across message content.
 *
 * Message-content candidates come from the sparse `messages_lexical` Qdrant
 * index (BM25-style), filtered by the visibility/archived SQL predicates and
 * merged with a `LIKE` match on conversation titles; matching conversations
 * return with their relevant messages, ordered by most recently updated.
 *
 * Content matching is index-only — there is no `messages.content` scan
 * fallback and no other content source. Only the title arm can match while
 * the index is not a safe read source ({@link isMessageContentSearchAvailable}),
 * for a query that tokenizes to nothing under the shared tokenizer (non-ASCII
 * or single-char input like "你", "é", "C++"), or when the Qdrant lexical
 * lookup fails (logged). An unindexed or unreachable index yields fewer
 * results, by design.
 *
 * The content cap lands on distinct conversations, not matching messages:
 * Qdrant ranks at message grain, so the read over-fetches a candidate pool
 * ({@link QDRANT_SEARCH_CANDIDATE_LIMIT}) and dedupes to
 * {@link CONVERSATION_SEARCH_DISTINCT_LIMIT} distinct visible conversations
 * in score order (see the constants' docstrings).
 */
export async function searchConversations(
  query: string,
  opts?: {
    limit?: number;
    maxMessagesPerConversation?: number;
    /**
     * When true, search results include conversations whose `archived_at`
     * is non-null. Defaults to `false` to preserve the historical
     * "search matches the sidebar" invariant (anything in the standard
     * listing is findable, archived rows are hidden). Surfaced only to
     * opt-in callers like the global Search box toggle — never applied to
     * background listing endpoints.
     */
    includeArchived?: boolean;
  },
): Promise<ConversationSearchResult[]> {
  if (!query.trim()) {
    return [];
  }

  ensureGroupMigration();
  const db = getDb();
  const trimmed = query.trim();
  const limit = opts?.limit ?? 20;
  const maxMsgsPerConv = opts?.maxMessagesPerConversation ?? 3;

  const hasTokens = hasLexicalTokens(trimmed);
  const contentSearchAvailable = isMessageContentSearchAvailable();

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
  // On a lexical-lookup failure it stays null, so the content arm contributes
  // nothing and only title matches surface.
  let qdrantCandidatesByConv: Map<string, string[]> | null = null;

  if (hasTokens && contentSearchAvailable) {
    // The lexical index is written asynchronously by the memory job queue, so
    // for a brief window after an edit it can lag SQLite: a search for a term
    // just removed from a message may still return that message id (or miss one
    // just added). This is an accepted async-indexing tradeoff — transient, and
    // results are re-sorted by `updated_at` — not re-verified against live
    // content here.
    let candidates: Awaited<ReturnType<typeof searchMessageIdsLexical>> = [];
    try {
      candidates = await searchMessageIdsLexical(
        trimmed,
        QDRANT_SEARCH_CANDIDATE_LIMIT,
      );
    } catch (err) {
      log.warn(
        { err, query: query.slice(0, 80) },
        "searchConversations: Qdrant lexical query failed — returning title matches only",
      );
    }

    if (candidates.length > 0) {
      const candidateIds = candidates.map((c) => c.messageId);
      // Filter the lexical candidates down to visible, non-archived
      // conversations in SQL (Qdrant has no visibility filtering). No SQL
      // LIMIT here: the row count is already bounded by the candidate pool
      // (≤ QDRANT_SEARCH_CANDIDATE_LIMIT), and capping in SQL would cap on
      // messages, not distinct conversations. The distinct-conversation cap is
      // applied below in Qdrant score order.
      interface CandidateRow {
        id: string;
        conversation_id: string;
      }
      const placeholders = candidateIds.map(() => "?").join(",");
      const whereClauses = [
        `m.id IN (${placeholders})`,
        standardListingVisibilitySql("c"),
      ];
      if (!opts?.includeArchived) {
        whereClauses.push(`c.archived_at IS NULL`);
      }
      // No completeness predicate: candidate ids come from the lexical
      // index, which filters finalized = 1 at index time, so an unfinalized
      // row cannot be a candidate. Do not copy this shape for id sets with
      // different provenance.
      const visibleRows = rawAll<CandidateRow>(
        "conversation:searchConversations:visibleCandidates",
        `
        SELECT m.id, m.conversation_id
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE ${whereClauses.join(" AND ")}
      `,
        ...candidateIds,
      );
      const visibleConvByMessageId = new Map<string, string>();
      for (const row of visibleRows) {
        visibleConvByMessageId.set(row.id, row.conversation_id);
      }

      // Walk candidates in Qdrant score order (highest first). Bucket each
      // visible candidate's message id under its conversation and stop
      // collecting NEW conversations once CONVERSATION_SEARCH_DISTINCT_LIMIT
      // distinct visible conversations are seen — so one chatty conversation
      // can't starve others, matching the FTS distinct-conversation cap.
      qdrantCandidatesByConv = new Map();
      for (const candidate of candidates) {
        const convId = visibleConvByMessageId.get(candidate.messageId);
        if (!convId) {
          continue;
        }
        const bucket = qdrantCandidatesByConv.get(convId);
        if (bucket) {
          bucket.push(candidate.messageId);
        } else {
          if (
            qdrantCandidatesByConv.size >= CONVERSATION_SEARCH_DISTINCT_LIMIT
          ) {
            continue;
          }
          qdrantCandidatesByConv.set(convId, [candidate.messageId]);
          contentConvIds.add(convId);
        }
      }
    }
  } else if (hasTokens) {
    // The lexical index is not a safe read source (memory disabled, or the
    // one-time upgrade backfill still draining) — the query can only match by
    // conversation title below. The breadcrumb explains an otherwise
    // surprising lack of content matches.
    log.info(
      { query: query.slice(0, 80) },
      "searchConversations: lexical index unavailable — title matches only",
    );
  } else {
    // The query tokenized to nothing (non-ASCII, single-char, etc. — "你",
    // "é", "C++"). Content matching is index-only, so such queries can only
    // match by conversation title below. The breadcrumb explains an otherwise
    // surprising empty result.
    log.info(
      { query: query.slice(0, 80) },
      "searchConversations: query produced no lexical tokens — title matches only",
    );
  }

  // Title-only matches (message-content indexes don't cover conversation titles).
  const titleConditions = [
    sql.raw(standardListingVisibilitySql()),
    sql`${conversations.title} LIKE ${titlePattern} ESCAPE '\\'`,
  ];
  if (!opts?.includeArchived) {
    titleConditions.push(sql`${conversations.archivedAt} IS NULL`);
  }
  const titleMatchConvs = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(...titleConditions))
    .all();
  for (const row of titleMatchConvs) {
    contentConvIds.add(row.id);
  }

  if (contentConvIds.size === 0) {
    return [];
  }

  // Fetch the matching conversation rows, ordered by updatedAt, capped at limit.
  const convIds = [...contentConvIds];
  const placeholders = convIds.map(() => "?").join(",");
  interface ConvRow {
    id: string;
    title: string | null;
    updated_at: number;
  }
  const matchingConversations = rawAll<ConvRow>(
    "conversation:searchConversations:matchingConversations",
    `SELECT id, title, updated_at FROM conversations
     WHERE id IN (${placeholders})
     ORDER BY updated_at DESC
     LIMIT ?`,
    ...convIds,
    limit,
  );

  if (matchingConversations.length === 0) {
    return [];
  }

  const results: ConversationSearchResult[] = [];

  for (const conv of matchingConversations) {
    // Conversations without content candidates — title-only matches, every
    // match on a no-token query, and all matches while content search is
    // unavailable or the Qdrant lookup failed — carry no content excerpts:
    // `matchingMsgs` stays empty.
    let matchingMsgs: ConversationSearchMsgRow[] = [];
    if (hasTokens && contentSearchAvailable) {
      // Reuse the lexical candidates already fetched above — no second Qdrant
      // round-trip. Select this conversation's candidate message rows by id,
      // ordered oldest-first.
      const candidateIds = qdrantCandidatesByConv?.get(conv.id) ?? [];
      if (candidateIds.length > 0) {
        const msgPlaceholders = candidateIds.map(() => "?").join(",");
        matchingMsgs = rawAll<ConversationSearchMsgRow>(
          "conversation:searchConversations:matchingMessages",
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
  let sawStructuredContent = false;
  const parts: string[] = [];
  let preservedExternalContent = false;

  const pushPart = (value: string): void => {
    if (externalContentMode === "display") {
      parts.push(unwrapExternalContentForDisplay(value));
    } else {
      const excerpt = buildRecallEvidenceText(value, query);
      parts.push(excerpt.text);
      preservedExternalContent ||= excerpt.preservedExternalContent;
    }
  };

  const walkBlocks = (blocks: unknown[]): void => {
    for (const block of blocks) {
      if (typeof block !== "object" || block == null) {
        continue;
      }
      const rec = block as Record<string, unknown>;
      if (rec.type === "text" && typeof rec.text === "string") {
        pushPart(rec.text);
      } else if (rec.type === "thinking" && typeof rec.thinking === "string") {
        pushPart(rec.thinking);
      } else if (
        rec.type === "file" &&
        typeof rec.extracted_text === "string"
      ) {
        pushPart(rec.extracted_text);
      } else if (
        rec.type === "tool_result" ||
        rec.type === "web_search_tool_result"
      ) {
        if (typeof rec.content === "string") {
          pushPart(rec.content);
        } else if (Array.isArray(rec.content)) {
          for (const inner of rec.content) {
            if (typeof inner !== "object" || inner == null) {
              continue;
            }
            const innerRec = inner as Record<string, unknown>;
            if (innerRec.type === "text" && typeof innerRec.text === "string") {
              pushPart(innerRec.text);
            }
          }
        }
      }
    }
  };

  if (parseContentRef(rawContent)) {
    sawStructuredContent = true;
    walkBlocks(resolveMessageContentBlocks(rawContent));
  } else {
    try {
      const parsed = JSON.parse(rawContent);
      if (Array.isArray(parsed)) {
        sawStructuredContent = true;
        walkBlocks(parsed);
      } else if (typeof parsed === "string") {
        text = parsed;
      } else if (typeof parsed === "object" && parsed != null) {
        sawStructuredContent = true;
      }
    } catch {
      // Not JSON, legacy plain-text rows are used as-is.
    }
  }

  if (parts.length > 0) {
    text = parts.join(" ");
    if (externalContentMode === "preserve" && preservedExternalContent) {
      return text;
    }
  } else if (sawStructuredContent && externalContentMode === "display") {
    // Structured content with no legible text (tool_use or image-only
    // blocks, unresolved refs): an empty excerpt beats raw JSON in the UI.
    return "";
  }

  if (externalContentMode === "display") {
    text = unwrapExternalContentForDisplay(text);
    return buildExcerptFromText(text, query, DISPLAY_EXCERPT_LEADING_CHARS);
  }
  const envelope = parseExternalContentEnvelope(text);
  if (envelope) {
    const innerExcerpt = buildExcerptFromText(envelope.content, query);
    return wrapRecallEvidenceExcerpt(
      innerExcerpt,
      envelope.source,
      envelope.origin,
    );
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Earliest case-insensitive match of the query in `text`: the contiguous
 * query when present, otherwise the earliest of its lexical tokens (same
 * tokenizer as the sparse index, which matches tokens independently).
 * Both branches are anchored to the tokenizer's alphanumeric boundaries
 * so neither the query nor a token ever matches inside a larger word the
 * index would tokenize differently. Matching runs on the original string
 * so offsets stay aligned even when lowercasing would change string
 * length (e.g. Turkish dotted I).
 */
function findEarliestMatch(
  text: string,
  query: string,
): { index: number; length: number } | null {
  const execAnchored = (pattern: string): RegExpExecArray | null => {
    return new RegExp(
      `(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`,
      "iu",
    ).exec(text);
  };

  const whole = execAnchored(escapeRegExp(query));
  if (whole) {
    return { index: whole.index, length: whole[0].length };
  }
  const tokens = [...new Set(tokenize(query))].sort(
    (a, b) => b.length - a.length,
  );
  if (tokens.length === 0) {
    return null;
  }
  const match = execAnchored(tokens.map(escapeRegExp).join("|"));
  return match ? { index: match.index, length: match[0].length } : null;
}

const EXCERPT_WINDOW = 100;

/**
 * Leading context for palette display excerpts. The result row truncates
 * from the right, so a wide leading window can push the match past the
 * visible cutoff; recall evidence keeps the full window.
 */
const DISPLAY_EXCERPT_LEADING_CHARS = 30;

function buildExcerptFromText(
  text: string,
  query: string,
  leadingChars: number = EXCERPT_WINDOW,
): string {
  const match = findEarliestMatch(text, query);
  if (!match) {
    // Neither the query nor any of its tokens is present (e.g. the lexical
    // index matched JSON structure instead); fall back to the text start.
    return text
      .slice(0, EXCERPT_WINDOW * 2)
      .replace(/\s+/g, " ")
      .trim();
  }
  const start = Math.max(0, match.index - leadingChars);
  const end = Math.min(
    text.length,
    match.index + match.length + EXCERPT_WINDOW,
  );
  const excerpt =
    (start > 0 ? "\u2026" : "") +
    text.slice(start, end).replace(/\s+/g, " ").trim() +
    (end < text.length ? "\u2026" : "");
  return excerpt;
}
