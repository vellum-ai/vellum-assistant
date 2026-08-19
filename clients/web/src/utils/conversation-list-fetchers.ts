/**
 * Fetch functions for the conversation list caches, plus the sidebar's two
 * non-list reads (unread count, section index).
 *
 * Every list read is the daemon's paginated `conversationsGet()` scoped by a
 * {@link ConversationListFilter}; four primitives cover them all: a drain
 * ({@link drainConversationList}), the newest page
 * ({@link listConversationsFirstPage}), a page at an offset
 * ({@link listConversationsPage}), and the newest foreground row
 * ({@link fetchNewestForegroundConversation}). Rows come back as `Conversation`
 * (`toConversation` runs here, in the fetch), shaped per bucket by
 * {@link shapeListRows}. Keys live in `conversation-list-keys.ts` and the
 * list `queryOptions` in `conversation-list-options.ts`.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/query-functions
 */

import { queryOptions } from "@tanstack/react-query";
import {
  conversationsGet,
  conversationsSectionsGet,
  conversationsUnreadcountGet,
} from "@/generated/daemon/sdk.gen";
import {
  conversationsSectionsGetQueryKey,
  conversationsUnreadcountGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type {
  ConversationsGetData,
  ConversationsSectionsGetResponse,
} from "@/generated/daemon/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
  toApiError,
} from "@/utils/api-errors";
import { recordDiagnostic } from "@/lib/diagnostics";
import { emitClientPerfEvent } from "@/lib/telemetry/client-perf";
import type { Conversation } from "@/types/conversation-types";
import { readContentLength } from "@/utils/content-length";
import {
  type ConversationListFilter,
  isArchivedFilter,
  isSectionFilter,
} from "@/utils/conversation-list-keys";
import { byTimestampDesc } from "@/utils/conversation-order";
import { isScheduledConversation } from "@/utils/conversation-predicates";
import { toConversation } from "@/utils/conversation-transforms";

/**
 * Key for the server-side unread conversation count
 * (`GET /v1/conversations/unread-count`). The cache holds `number | null`
 * (see {@link fetchUnreadConversationCount}).
 *
 * Deliberately the generated key, NOT a child of
 * the list prefix (`conversationListPrefix` in `conversation-list-keys.ts`):
 * the prefix-wide helpers in `conversation-cache.ts` treat every entry
 * under it as a {@link ConversationListPage}, and this cache holds a scalar.
 * The generated key's `_id` keeps the two apart.
 */
export function unreadConversationCountQueryKey(assistantId: string | null) {
  return conversationsUnreadcountGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  });
}

// ---------------------------------------------------------------------------
// Internal pagination helper
// ---------------------------------------------------------------------------

/**
 * Rows per list request. Exported for callers that page a list read by hand
 * (`listConversationsPage` takes an offset): the daemon advances by this
 * limit, and appends pinned rows to an unfiltered page one beyond it, so a
 * caller advancing by the rows it received would skip rows.
 */
export const CONVERSATION_LIST_PAGE_SIZE = 50;
const CONVERSATION_LIST_MAX_PAGES = 200;

/**
 * Origin channel filter values accepted by the daemon's
 * `GET /v1/conversations?originChannel=` parameter.
 */
type ConversationListQuery = NonNullable<ConversationsGetData["query"]>;

export type OriginChannel = ConversationListQuery["originChannel"];

/**
 * The same set as {@link OriginChannel}, at runtime.
 *
 * A sidebar channel section is keyed by whatever `origin_channel` its rows
 * carried, which is a plain string, so sending it as a query parameter needs a
 * membership check first. `_Exhaustive` fails to compile if the generated
 * union gains a channel this list is missing, so a schema change surfaces here
 * rather than as a section that silently stops filtering.
 */
export const ORIGIN_CHANNELS = [
  "telegram",
  "phone",
  "vellum",
  "whatsapp",
  "slack",
  "email",
  "platform",
  "a2a",
  "discord",
] as const satisfies readonly NonNullable<OriginChannel>[];

type _Exhaustive =
  NonNullable<OriginChannel> extends (typeof ORIGIN_CHANNELS)[number]
    ? true
    : never;

/**
 * Group filter accepted by `GET /v1/conversations?groupId=`. Derived from the
 * generated query type rather than restated, so a schema change surfaces
 * here as a type error.
 */
export type ConversationGroupId = ConversationListQuery["groupId"];

/**
 * Closed set of list labels carried by the `client_list.drain` watchdog event
 * and by every conversation-list ring entry. One label per real caller, so the
 * archive page and the channel sections stay distinguishable from the sidebar's
 * foreground drain in both rails.
 */
type DrainListKind =
  | "foreground"
  | "background"
  | "scheduled"
  | "archived"
  | "origin_channel"
  | "section";

/**
 * Label a drain by the list it is fetching. Archive status is checked first
 * because the archive page drains both the foreground and the background
 * bucket, and both are archive-page cost rather than sidebar cost. Every
 * channel collapses to one `"origin_channel"` label so the set stays bounded
 * as channels are added.
 */
function drainListKind(options: ConversationListFilter): DrainListKind {
  if (isArchivedFilter(options)) {
    return "archived";
  }
  if (options.conversationType !== undefined) {
    return options.conversationType;
  }
  if (options.originChannel !== undefined) {
    return "origin_channel";
  }
  if (options.groupId !== undefined) {
    return "section";
  }
  return "foreground";
}

/** One page of a conversation list plus whether more pages exist. */
export type ConversationListPage = {
  conversations: Conversation[];
  hasMore: boolean;
};

/**
 * Per-bucket shaping applied to every list read before it is cached, as
 * data on the filter so there is one fetch path.
 *
 * A section (a group or channel filter) keeps server order: it renders the
 * server's recency order as-is (LUM-3108), and a client sort could disagree
 * with it on ties. The archived reads sort by `archivedAt`, the other
 * buckets by `lastMessageAt`. The active background bucket drops scheduled
 * rows: the daemon's `background` value is the back-compat umbrella that
 * includes them, and the sidebar keeps one conversation in one cache, with
 * scheduled runs in their own bucket. The archived background read keeps
 * them, because the archive view shows every type and there is no
 * archived-scheduled cache to hold them.
 */
function shapeListRows(
  filter: ConversationListFilter,
  rows: Conversation[],
): Conversation[] {
  if (isSectionFilter(filter)) {
    return rows;
  }
  const kept =
    filter.conversationType === "background" && !isArchivedFilter(filter)
      ? rows.filter((c) => !isScheduledConversation(c))
      : rows;
  return [...kept].sort(
    byTimestampDesc(isArchivedFilter(filter) ? "archivedAt" : "lastMessageAt"),
  );
}

/**
 * A page plus what it cost to fetch. Module-private, and every exported
 * fetcher projects it down to the {@link ConversationListPage} fields by hand,
 * so the cost fields never reach callers.
 */
type TimedConversationListPage = ConversationListPage & {
  /** HTTP status of the response that produced this page (always 2xx). */
  status: number;
  durationMs: number;
  /** `content-length` in bytes, or null when the header is missing or junk. */
  bytes: number | null;
};

/** Which path issued an offset-0 list GET. */
/**
 * `landing` is the cold-boot landing lookup (`landing-conversation.ts`),
 * kept apart from a sync refresh so a slow boot is attributable to it.
 */
type FirstPageFetchSource = "drain" | "first_page_refresh" | "landing";
export type FirstPageReadSource = Exclude<FirstPageFetchSource, "drain">;

/**
 * Superset of {@link FirstPageFetchSource} for the error entry, which any
 * caller of {@link fetchConversationListPage} can produce, including the
 * onboarding existence probe.
 */
type ListFetchSource = FirstPageFetchSource | "existence_probe" | "load_more";

/**
 * Ring entry for one offset-0 list GET, shared by the drain's first page and
 * the standalone first-page fetchers. The standalone ones run debounced (250ms)
 * behind sync events, so their share of the 200-entry ring stays small.
 *
 * `listKind` and `source` together fingerprint the caller: without them every
 * bucket's first page reads as the same offset-0 request, and a slow entry is
 * not attributable to the path the user waited on.
 *
 * {@link hasAnyActiveConversation} contributes no success entry: it is an
 * offset-0 existence probe on the onboarding path, not a list the user is
 * waiting to see, so keeping it out preserves the ring for real list fetches.
 * A failed probe still lands one `conversation_list_page_fetch_error`, labeled
 * `source: "existence_probe"` so it cannot be mistaken for a drain failure.
 */
function recordFirstPageFetch(
  assistantId: string,
  page: TimedConversationListPage,
  listKind: DrainListKind,
  source: FirstPageFetchSource,
): void {
  recordDiagnostic("conversation_list_page_fetch", {
    assistantId,
    offset: 0,
    status: page.status,
    count: page.conversations.length,
    hasMore: page.hasMore,
    durationMs: page.durationMs,
    bytes: page.bytes,
    listKind,
    source,
  });
}

async function fetchConversationListPage(
  assistantId: string,
  offset: number,
  source: ListFetchSource,
  filter: ConversationListFilter = {},
  limit: number = CONVERSATION_LIST_PAGE_SIZE,
): Promise<TimedConversationListPage> {
  const startedAt = performance.now();
  const { data, error, response } = await conversationsGet({
    path: { assistant_id: assistantId },
    query: { ...filter, limit, offset },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to list conversations.");
  const durationMs = Math.round(performance.now() - startedAt);
  if (!response.ok) {
    recordDiagnostic("conversation_list_page_fetch_error", {
      assistantId,
      offset,
      status: response.status,
      durationMs,
      bytes: readContentLength(response),
      listKind: drainListKind(filter),
      source,
    });
    const msg = extractErrorMessage(
      error,
      response,
      "Failed to list conversations.",
    );
    throw new ApiError(response.status, msg);
  }

  return {
    conversations: (data?.conversations ?? []).map(toConversation),
    hasMore: data?.hasMore ?? false,
    status: response.status,
    durationMs,
    bytes: readContentLength(response),
  };
}

/**
 * Every row matching `filter`, drained page by page and shaped for its
 * bucket ({@link shapeListRows}).
 *
 * The four bucket caches (foreground, background, scheduled, archived)
 * drain because their readers assume a complete list; a section drains
 * only for the bulk-action path (`getAllRows` in
 * `use-section-conversations.ts`), which must cover a section's full
 * membership while its rendered cache is a window. Bulk archive and
 * mark-all-read send explicit id lists, so their completeness is exactly
 * this list's completeness; a server-side group-scoped bulk operation
 * replaces that drain. Do not reach for a drain anywhere new: a windowed
 * cache plus load-more is the shape everything else uses.
 */
export async function drainConversationList(
  assistantId: string,
  filter: ConversationListFilter = {},
): Promise<Conversation[]> {
  const all: Conversation[] = [];
  const seen = new Set<string>();

  // A full drain can be dozens of pages, so only the first page (the one that
  // gates first paint) and a single summary reach the 200-entry ring.
  const drainStartedAt = performance.now();
  let pages = 0;
  let maxPageMs = 0;
  let totalBytes: number | null = null;

  const recordDrain = (outcome: "ok" | "error"): void => {
    const totalMs = Math.round(performance.now() - drainStartedAt);
    recordDiagnostic("conversation_list_drain", {
      assistantId,
      outcome,
      pages,
      rows: all.length,
      totalMs,
      maxPageMs,
      totalBytes,
      listKind: drainListKind(filter),
    });
    // The ring keeps `assistantId` for feedback bundles; the telemetry rail is
    // metadata only.
    emitClientPerfEvent("client_list.drain", totalMs, {
      outcome,
      pages,
      rows: all.length,
      max_page_ms: maxPageMs,
      total_bytes: totalBytes,
      list_kind: drainListKind(filter),
    });
  };

  try {
    for (let page = 0; page < CONVERSATION_LIST_MAX_PAGES; page++) {
      const offset = page * CONVERSATION_LIST_PAGE_SIZE;
      const result = await fetchConversationListPage(
        assistantId,
        offset,
        "drain",
        filter,
      );
      pages++;
      maxPageMs = Math.max(maxPageMs, result.durationMs);
      if (result.bytes !== null) {
        totalBytes = (totalBytes ?? 0) + result.bytes;
      }
      if (page === 0) {
        recordFirstPageFetch(
          assistantId,
          result,
          drainListKind(filter),
          "drain",
        );
      }
      for (const conversation of result.conversations) {
        if (!seen.has(conversation.conversationId)) {
          seen.add(conversation.conversationId);
          all.push(conversation);
        }
      }

      if (!result.hasMore) {
        break;
      }

      if (result.conversations.length === 0) {
        break;
      }
    }
  } catch (error) {
    recordDrain("error");
    throw error;
  }

  recordDrain("ok");
  return shapeListRows(filter, all);
}

// ---------------------------------------------------------------------------
// Public fetchers
// ---------------------------------------------------------------------------

/**
 * Whether the assistant has ANY active (non-archived) foreground conversation.
 * One page answers existence, so this never walks the full list. Used by the
 * onboarding established-assistant guard to detect a lived-in assistant before
 * the flow fires anything at it. Throws on fetch failure — callers own the
 * fail-open policy.
 */
export async function hasAnyActiveConversation(
  assistantId: string,
): Promise<boolean> {
  const { conversations } = await fetchConversationListPage(
    assistantId,
    0,
    "existence_probe",
  );
  return conversations.length > 0;
}

/**
 * The newest conversation the user can open, as one row: `limit=1` on the
 * foreground list with `foregroundOnly=true`, so the daemon applies its own
 * "not an unsurfaced background or scheduled run" predicate and its own
 * order, and the first row is the answer. `null` when the daemon has none.
 *
 * An assistant that predates the parameter ignores it and answers with the
 * newest row of the unfiltered listing (plus its appended pinned rows, which
 * this read drops). That row is not necessarily openable, and the caller
 * decides what to do about it: `landing-conversation.ts` checks the row
 * against the client's selectability rule and falls back to a paged search
 * when it fails, which is how it detects the older assistant without a
 * version gate.
 *
 * Reported to the diagnostics ring as a `landing` first-page read of the
 * foreground list; the label set is closed, and this is that read at a
 * smaller limit.
 */
export async function fetchNewestForegroundConversation(
  assistantId: string,
): Promise<Conversation | null> {
  const page = await fetchConversationListPage(
    assistantId,
    0,
    "landing",
    { foregroundOnly: "true" },
    1,
  );
  recordFirstPageFetch(assistantId, page, "foreground", "landing");
  return page.conversations[0] ?? null;
}

/**
 * The two group ids the daemon owns. Pinning is stored as group membership,
 * and `system:all` is what no group claimed, so a conversation belongs to
 * exactly one group and group-scoped lists never overlap.
 */
export const SYSTEM_PINNED_GROUP_ID = "system:pinned";
export const SYSTEM_ALL_GROUP_ID = "system:all";

/**
 * The `originChannel` value for a conversation started in Vellum rather than
 * arriving from an external channel, and so the filter the Chats section
 * asks for.
 *
 * Typed against the generated union, so removing it from the schema fails
 * the build here rather than sending a value the daemon rejects.
 */
export const NATIVE_ORIGIN_CHANNEL: NonNullable<OriginChannel> = "vellum";

/**
 * Read the server-side unread conversation count, mapping a 404 to `null`.
 *
 * An assistant without `GET /v1/conversations/unread-count` 404s this read;
 * resolving `null` lets consumers fall back to the client-derived count and
 * lets a refetch clear a count from a since-rolled-back assistant instead of
 * stranding it (see "When a gate is unnecessary" in BACKWARDS_COMPAT.md).
 * Every other HTTP failure throws a status-carrying {@link ApiError} so the
 * app-level no-retry-4xx policy applies; a missing response (network error)
 * rethrows raw and retries as transient.
 */
export async function fetchUnreadConversationCount(
  assistantId: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const { data, error, response } = await conversationsUnreadcountGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
    signal,
  });
  assertHasResponse(
    response,
    error,
    "Failed to fetch unread conversation count.",
  );
  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw toApiError(error, response);
  }
  return data?.count ?? null;
}

/** One renderable sidebar section as the daemon indexes it. */
export type SidebarIndexSection =
  ConversationsSectionsGetResponse["sections"][number];

/**
 * Key for the sidebar section index (`GET /v1/conversations/sections`). The
 * cache holds `SidebarIndexSection[] | null` (see
 * {@link fetchSidebarSections}).
 *
 * Not a list cache, for the same reason as the unread count: the
 * prefix-wide helpers in `conversation-cache.ts` treat every entry under
 * the list prefix as a {@link ConversationListPage}, and this cache holds
 * section rows.
 */
export function sidebarSectionsQueryKey(assistantId: string | null) {
  return conversationsSectionsGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  });
}

/**
 * Read the sidebar section index, mapping a 404 to `null`.
 *
 * An assistant without `GET /v1/conversations/sections` 404s this read;
 * resolving `null` lets the sidebar keep deriving section existence from the
 * loaded list, and lets a refetch clear an index from a since-rolled-back
 * assistant instead of stranding it (see "When a gate is unnecessary" in
 * BACKWARDS_COMPAT.md). Every other HTTP failure throws a status-carrying
 * {@link ApiError} so the app-level no-retry-4xx policy applies; a missing
 * response (network error) rethrows raw and retries as transient.
 */
export async function fetchSidebarSections(
  assistantId: string,
  signal?: AbortSignal,
): Promise<SidebarIndexSection[] | null> {
  const { data, error, response } = await conversationsSectionsGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
    signal,
  });
  assertHasResponse(response, error, "Failed to fetch sidebar sections.");
  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw toApiError(error, response);
  }
  return data?.sections ?? null;
}

// ---------------------------------------------------------------------------
// Page fetchers
//
// Single-request reads. The first-page read refreshes the top of a cached
// list without re-draining every page (at thousands of conversations a
// drain is hundreds of sequential GETs, which exhausts the daemon's
// per-client rate-limit budget when sync events arrive continuously during
// an active turn), and it is the whole cold read for a windowed section.
// Both return `hasMore` so callers can tell a complete list from a window.
// ---------------------------------------------------------------------------

/**
 * The newest page of the list `filter` names, shaped for its bucket
 * ({@link shapeListRows}).
 */
export async function listConversationsFirstPage(
  assistantId: string,
  filter: ConversationListFilter = {},
  source: FirstPageReadSource = "first_page_refresh",
): Promise<ConversationListPage> {
  const page = await fetchConversationListPage(assistantId, 0, source, filter);
  recordFirstPageFetch(assistantId, page, drainListKind(filter), source);
  return {
    conversations: shapeListRows(filter, page.conversations),
    hasMore: page.hasMore,
  };
}

/**
 * One page at an arbitrary offset, for extending a windowed cache
 * (`loadMoreConversations`). Server order, unshaped: a load-more appends
 * below rows already on screen.
 *
 * The offset is the caller's cached row count, not a stored page cursor:
 * optimistic writes add and remove rows, so a cursor recorded at fetch time
 * would drift from the rows actually held. Computing from the live cache
 * self-corrects; overlap from concurrent server-side changes is deduped by
 * id at the append, and a skipped row surfaces on the next first-page merge
 * or deeper load.
 */
export async function listConversationsPage(
  assistantId: string,
  filter: ConversationListFilter,
  offset: number,
): Promise<ConversationListPage> {
  const page = await fetchConversationListPage(
    assistantId,
    offset,
    "load_more",
    filter,
  );
  return { conversations: page.conversations, hasMore: page.hasMore };
}

// ---------------------------------------------------------------------------
// queryOptions factories
//
// The list caches' options live in `conversation-list-options.ts`; these
// two are the sidebar's other reads. Co-locate queryKey + queryFn +
// staleTime so hooks can spread them into useQuery() and imperative callers
// can use .queryKey for cache operations.
//
// References:
// - https://tanstack.com/query/latest/docs/framework/react/guides/query-options
// - https://tkdodo.eu/blog/the-query-options-api
// ---------------------------------------------------------------------------

const QUERY_STALE_TIME_MS = 30_000;

/**
 * Query options for the server-side unread conversation count. The cache
 * holds `number | null`; `null` means the connected assistant does not
 * serve the endpoint (see {@link fetchUnreadConversationCount}).
 *
 * `refetchOnWindowFocus` is disabled: count changes arrive via
 * `sync_changed`-driven invalidation and mutation settles, and a focus
 * refetch would re-issue the 404 against assistants without the route.
 */
export function unreadConversationCountOptions(assistantId: string) {
  return queryOptions({
    queryKey: unreadConversationCountQueryKey(assistantId),
    queryFn: ({ signal }) => fetchUnreadConversationCount(assistantId, signal),
    staleTime: QUERY_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
}

/**
 * Query options for the sidebar section index. The cache holds
 * `SidebarIndexSection[] | null`; `null` means the connected assistant does
 * not serve the endpoint (see {@link fetchSidebarSections}).
 *
 * `refetchOnWindowFocus` is disabled for the same reason as the unread
 * count: freshness arrives via `sync_changed`-driven invalidation, and a
 * focus refetch would re-issue the 404 against assistants without the route.
 */
export function sidebarSectionsOptions(assistantId: string) {
  return queryOptions({
    queryKey: sidebarSectionsQueryKey(assistantId),
    queryFn: ({ signal }) => fetchSidebarSections(assistantId, signal),
    staleTime: QUERY_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
}
