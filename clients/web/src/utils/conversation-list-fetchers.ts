/**
 * Fetch functions and `queryOptions` factories for conversation lists
 * (foreground, background, scheduled, archived).
 *
 * Each fetcher returns a sorted `Conversation[]` from the daemon's paginated
 * `conversationsGet()` endpoint. The `queryOptions` factories co-locate
 * `queryKey` + `queryFn` + `staleTime` so consumers can spread them into
 * `useQuery()`, pass them to `queryClient.prefetchQuery()`, or destructure
 * `.queryKey` for imperative cache operations — all with full type safety.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/query-options
 * - https://tanstack.com/query/latest/docs/framework/react/guides/query-functions
 * - https://tanstack.com/query/latest/docs/eslint/prefer-query-options
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
  byTimestampDesc,
  mergeListFirstPage,
} from "@/utils/conversation-order";
import { isScheduledConversation } from "@/utils/conversation-predicates";
import { toConversation } from "@/utils/conversation-transforms";

// ---------------------------------------------------------------------------
// Conversation list query keys
//
// All conversation list caches share a common prefix:
//   ["conversation-list", assistantId, ...discriminator]
//
// This enables TanStack Query's prefix matching to operate on ALL
// conversation caches simultaneously (cancel, invalidate, snapshot, patch)
// without maintaining a static registry.
// ---------------------------------------------------------------------------

export const CONVERSATION_LIST_PREFIX = "conversation-list" as const;

/** Prefix key matching ALL conversation list caches for the given assistant. */
export function conversationListPrefix(assistantId: string | null) {
  return [CONVERSATION_LIST_PREFIX, assistantId ?? ""] as const;
}

export function conversationsQueryKey(assistantId: string | null) {
  return [CONVERSATION_LIST_PREFIX, assistantId ?? "", "foreground"] as const;
}

export function archivedConversationsQueryKey(assistantId: string | null) {
  return [CONVERSATION_LIST_PREFIX, assistantId ?? "", "archived"] as const;
}

export function backgroundConversationsQueryKey(assistantId: string | null) {
  return [CONVERSATION_LIST_PREFIX, assistantId ?? "", "background"] as const;
}

export function scheduledConversationsQueryKey(assistantId: string | null) {
  return [CONVERSATION_LIST_PREFIX, assistantId ?? "", "scheduled"] as const;
}

/** Prefix key matching every per-section conversation cache. */
export function sectionListPrefix(assistantId: string | null) {
  return [CONVERSATION_LIST_PREFIX, assistantId ?? "", "section"] as const;
}

/**
 * Key for one section's conversation cache, a child of
 * {@link sectionListPrefix} so prefix-match invalidation reaches every
 * section at once.
 *
 * Both filter axes are in the key because both can be set at once, and two
 * sections differing only in channel must not share a cache entry.
 */
export function sectionConversationsQueryKey(
  assistantId: string | null,
  filter: SectionConversationFilter,
) {
  return [
    CONVERSATION_LIST_PREFIX,
    assistantId ?? "",
    "section",
    filter.groupId ?? "",
    filter.originChannel ?? "",
  ] as const;
}

/**
 * Recover the filter a section cache was keyed by, or `null` when the key
 * is not a section key.
 *
 * The decoder to {@link sectionConversationsQueryKey}'s encoder, and it lives
 * beside it so the two cannot drift. It exists because a local write has to
 * answer "does this row belong in *this* cache", and the only statement of
 * what a cache holds is its own key: TanStack's `setQueriesData` hands its
 * updater the data alone, never the key it came from, so a membership-aware
 * write has to walk `getQueriesData` and decode each key itself.
 *
 * @see {@link https://tanstack.com/query/latest/docs/reference/QueryClient#queryclientsetqueriesdata}
 */
export function parseSectionConversationsQueryKey(
  queryKey: readonly unknown[],
): SectionConversationFilter | null {
  const [prefix, , discriminator, groupId, originChannel] = queryKey;
  if (
    prefix !== CONVERSATION_LIST_PREFIX ||
    discriminator !== "section" ||
    typeof groupId !== "string" ||
    typeof originChannel !== "string"
  ) {
    return null;
  }
  /* The encoder writes "" for an absent axis, so "" decodes back to absent
     rather than to a filter on the empty string. */
  return {
    ...(groupId === "" ? {} : { groupId: groupId as ConversationGroupId }),
    ...(originChannel === ""
      ? {}
      : { originChannel: originChannel as OriginChannel }),
  };
}

/**
 * Key for the server-side unread conversation count
 * (`GET /v1/conversations/unread-count`). The cache holds `number | null`
 * (see {@link fetchUnreadConversationCount}).
 *
 * Deliberately the generated key, NOT a child of
 * {@link conversationListPrefix}: the prefix-wide helpers in
 * `conversation-cache.ts` treat every entry under the prefix as a
 * `Conversation[]`, and this cache holds a scalar.
 */
export function unreadConversationCountQueryKey(assistantId: string | null) {
  return conversationsUnreadcountGetQueryKey({
    path: { assistant_id: assistantId ?? "" },
  });
}

// ---------------------------------------------------------------------------
// Internal pagination helper
// ---------------------------------------------------------------------------

const CONVERSATION_LIST_PAGE_SIZE = 50;
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
 * What one sidebar section asks the server for.
 *
 * Both axes together, because a section can need both: a channel card is
 * that channel *and* ungrouped, since `origin_channel` is a separate column
 * from `group_id` and a Slack conversation filed into a custom group would
 * otherwise render in two cards.
 */
export interface SectionConversationFilter {
  groupId?: ConversationGroupId;
  originChannel?: OriginChannel;
}

type FetchConversationListOptions = {
  conversationType?: "background" | "scheduled";
  /**
   * Filter by archive state. Defaults to `"active"` on the daemon side, so
   * omitting this returns non-archived rows only — matching how the sidebar
   * wants to read the list. The Archive page passes `"archived"`.
   */
  archiveStatus?: "active" | "archived" | "all";
  /**
   * Filter by origin channel. When provided, only conversations with this
   * exact `origin_channel` value are returned.
   */
  originChannel?: OriginChannel;
  /**
   * Filter to one group: {@link SYSTEM_PINNED_GROUP_ID} for Pinned,
   * {@link SYSTEM_ALL_GROUP_ID} for what no group claimed, or a custom
   * group's id.
   *
   * A conversation carries exactly one `group_id`, so group-scoped lists are
   * disjoint by construction and no section needs to subtract another's rows.
   * The server orders a group-scoped request by the user's own arrangement
   * (display order, then recency) and never appends pinned rows to it.
   */
  groupId?: ConversationGroupId;
};

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
function drainListKind(options: FetchConversationListOptions): DrainListKind {
  if (options.archiveStatus === "archived") {
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
type FirstPageFetchSource = "drain" | "first_page_refresh";

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
  options: FetchConversationListOptions = {},
): Promise<TimedConversationListPage> {
  const { conversationType, archiveStatus, originChannel, groupId } = options;
  const startedAt = performance.now();
  const { data, error, response } = await conversationsGet({
    path: { assistant_id: assistantId },
    query: {
      limit: CONVERSATION_LIST_PAGE_SIZE,
      offset,
      ...(conversationType ? { conversationType } : {}),
      ...(archiveStatus ? { archiveStatus } : {}),
      ...(originChannel ? { originChannel } : {}),
      ...(groupId ? { groupId } : {}),
    },
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
      listKind: drainListKind(options),
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

async function fetchConversationList(
  assistantId: string,
  options: FetchConversationListOptions = {},
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
      listKind: drainListKind(options),
    });
    // The ring keeps `assistantId` for feedback bundles; the telemetry rail is
    // metadata only.
    emitClientPerfEvent("client_list.drain", totalMs, {
      outcome,
      pages,
      rows: all.length,
      max_page_ms: maxPageMs,
      total_bytes: totalBytes,
      list_kind: drainListKind(options),
    });
  };

  try {
    for (let page = 0; page < CONVERSATION_LIST_MAX_PAGES; page++) {
      const offset = page * CONVERSATION_LIST_PAGE_SIZE;
      const result = await fetchConversationListPage(
        assistantId,
        offset,
        "drain",
        options,
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
          drainListKind(options),
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
  return all;
}

// ---------------------------------------------------------------------------
// Merged list (foreground + background, deduplicated)
// ---------------------------------------------------------------------------

/**
 * Fetch active or archived conversations for an assistant — foreground and
 * background buckets fetched in parallel, deduplicated by `conversationId`,
 * and sorted. Used by the Conversations browser, which lists every
 * conversation type together.
 *
 * Either bucket failing rejects the whole list. The caller presents this as
 * the complete set, so silently dropping the background rows would read as
 * "these don't exist" rather than "these didn't load" — and an archived row
 * that looks gone is worse than an error with a retry.
 *
 * @param archiveStatus — `"active"` or `"archived"` (archive page)
 * @param sortKey — which timestamp to sort descending by (default: `lastMessageAt`)
 */
async function fetchMergedConversationList(
  assistantId: string,
  archiveStatus: "active" | "archived" = "active",
  sortKey: "lastMessageAt" | "archivedAt" = "lastMessageAt",
): Promise<Conversation[]> {
  const opts: FetchConversationListOptions =
    archiveStatus === "active" ? {} : { archiveStatus };
  const bgOpts: FetchConversationListOptions = {
    ...opts,
    conversationType: "background",
  };

  const [foregroundResult, backgroundResult] = await Promise.allSettled([
    fetchConversationList(assistantId, opts),
    fetchConversationList(assistantId, bgOpts),
  ]);

  if (foregroundResult.status === "rejected") {
    throw foregroundResult.reason;
  }
  if (backgroundResult.status === "rejected") {
    throw backgroundResult.reason;
  }

  const foreground = foregroundResult.value;
  const background = backgroundResult.value;

  const seen = new Set<string>();
  const conversations: Conversation[] = [];
  for (const conversation of [...foreground, ...background]) {
    if (seen.has(conversation.conversationId)) {
      continue;
    }
    seen.add(conversation.conversationId);
    conversations.push(conversation);
  }

  conversations.sort(byTimestampDesc(sortKey));
  return conversations;
}

// ---------------------------------------------------------------------------
// Public fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch all active (non-archived) foreground conversations for a given
 * assistant, sorted newest-first.
 *
 * Background and scheduled jobs are intentionally excluded — they load
 * through `listBackgroundConversations` / `listScheduledConversations` only
 * once the user expands the Background/Scheduled sidebar sections, so a large
 * background backlog never blocks the initial chat render (the conversation
 * the user actually opened).
 */
export async function listConversations(
  assistantId: string,
): Promise<Conversation[]> {
  const foreground = await fetchConversationList(assistantId);
  return [...foreground].sort(byTimestampDesc("lastMessageAt"));
}

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
 * Fetch all active (non-archived) background conversations for a given
 * assistant, sorted newest-first.
 *
 * The daemon's `conversationType=background` filter is the back-compat
 * umbrella that also returns scheduled rows, so those are filtered out here
 * to keep the background cache disjoint from the scheduled cache (one
 * conversation, one cache). Scheduled jobs load through
 * `listScheduledConversations` instead.
 *
 * Mounted lazily by the sidebar — only enabled once the user reveals the
 * Background section — so this never runs on the initial load path. Cached
 * separately from the foreground list under `backgroundConversationsQueryKey`.
 */
export async function listBackgroundConversations(
  assistantId: string,
): Promise<Conversation[]> {
  const background = await fetchConversationList(assistantId, {
    conversationType: "background",
  });
  return background
    .filter((c) => !isScheduledConversation(c))
    .sort(byTimestampDesc("lastMessageAt"));
}

/**
 * Fetch all active (non-archived) scheduled conversations for a given
 * assistant, sorted newest-first.
 *
 * Uses the daemon's dedicated `conversationType=scheduled` filter so the
 * Scheduled sidebar section can load independently of the background
 * backlog. Mounted lazily — only enabled once the user reveals the
 * Scheduled section — so this never runs on the initial load path. Cached
 * separately under `scheduledConversationsQueryKey`.
 */
export async function listScheduledConversations(
  assistantId: string,
): Promise<Conversation[]> {
  const scheduled = await fetchConversationList(assistantId, {
    conversationType: "scheduled",
  });
  return [...scheduled].sort(byTimestampDesc("lastMessageAt"));
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
 * Fetch all archived conversations for the archive page.
 * Sorted by `archivedAt` descending (most recently archived first).
 */
export async function listArchivedConversations(
  assistantId: string,
): Promise<Conversation[]> {
  return fetchMergedConversationList(assistantId, "archived", "archivedAt");
}

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
 * The generated key, NOT a child of {@link conversationListPrefix}, for the
 * same reason as the unread count: the prefix-wide helpers in
 * `conversation-cache.ts` treat every entry under the prefix as a
 * `Conversation[]`, and this cache holds section rows.
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
// First-page fetchers
//
// Single-request variants of the list fetchers above, used by the
// sync_changed consumer to refresh the top of a cached list without
// re-draining every page. At thousands of conversations the full drain is
// hundreds of sequential GETs, which exhausts the daemon's per-client
// rate-limit budget when sync events arrive continuously during an active
// turn. Each returns the bucket's newest rows (one page, already filtered
// and sorted with the same semantics as its full-list counterpart) plus
// `hasMore` so callers can tell a complete list from a window.
// ---------------------------------------------------------------------------

/** First page of {@link listConversations} (foreground bucket). */
export async function listConversationsFirstPage(
  assistantId: string,
): Promise<ConversationListPage> {
  const page = await fetchConversationListPage(
    assistantId,
    0,
    "first_page_refresh",
  );
  recordFirstPageFetch(assistantId, page, "foreground", "first_page_refresh");
  return {
    conversations: [...page.conversations].sort(
      byTimestampDesc("lastMessageAt"),
    ),
    hasMore: page.hasMore,
  };
}

/** First page of {@link listBackgroundConversations} (background bucket). */
export async function listBackgroundConversationsFirstPage(
  assistantId: string,
): Promise<ConversationListPage> {
  const page = await fetchConversationListPage(
    assistantId,
    0,
    "first_page_refresh",
    { conversationType: "background" },
  );
  recordFirstPageFetch(assistantId, page, "background", "first_page_refresh");
  return {
    conversations: page.conversations
      .filter((c) => !isScheduledConversation(c))
      .sort(byTimestampDesc("lastMessageAt")),
    hasMore: page.hasMore,
  };
}

/** First page of {@link listScheduledConversations} (scheduled bucket). */
export async function listScheduledConversationsFirstPage(
  assistantId: string,
): Promise<ConversationListPage> {
  const page = await fetchConversationListPage(
    assistantId,
    0,
    "first_page_refresh",
    { conversationType: "scheduled" },
  );
  recordFirstPageFetch(assistantId, page, "scheduled", "first_page_refresh");
  return {
    conversations: [...page.conversations].sort(
      byTimestampDesc("lastMessageAt"),
    ),
    hasMore: page.hasMore,
  };
}

/**
 * First page of one sidebar section's conversations.
 *
 * Server order is preserved rather than re-sorted: a section renders the
 * server's order as-is (recency, LUM-3108), and a client-side sort here
 * could disagree with it on ties.
 */
export async function listSectionConversationsFirstPage(
  assistantId: string,
  filter: SectionConversationFilter,
): Promise<ConversationListPage> {
  const page = await fetchConversationListPage(
    assistantId,
    0,
    "first_page_refresh",
    filter,
  );
  recordFirstPageFetch(
    assistantId,
    page,
    drainListKind(filter),
    "first_page_refresh",
  );
  return { conversations: page.conversations, hasMore: page.hasMore };
}

/**
 * Every row of one section, drained page by page.
 *
 * Transitional, and deliberately narrow: the only caller is the bulk-action
 * path (`getAllRows` in `use-section-conversations.ts`), which must cover a
 * section's full membership while the rendered cache is a window
 * (LUM-2444). Bulk archive / mark-all-read send explicit id lists, so their
 * completeness is exactly this list's completeness. The better shape is a
 * server-side group-scoped bulk operation (one filter parameter instead of
 * an id list); when that exists, this drain goes with it. Do not reach for
 * this anywhere new - a windowed cache plus load-more is the shape
 * everything else uses.
 */
export async function drainSectionConversations(
  assistantId: string,
  filter: SectionConversationFilter,
): Promise<Conversation[]> {
  return fetchConversationList(assistantId, filter);
}

/**
 * One page of a section's conversations at an arbitrary offset, for
 * extending a windowed cache (`loadMoreSectionConversations`).
 *
 * The offset is the caller's cached row count, not a stored page cursor:
 * optimistic writes add and remove rows, so a cursor recorded at fetch time
 * would drift from the rows actually held. Computing from the live cache
 * self-corrects; overlap from concurrent server-side changes is deduped by
 * id at the append, and a skipped row surfaces on the next first-page merge
 * or deeper load.
 */
export async function listSectionConversationsPage(
  assistantId: string,
  filter: SectionConversationFilter,
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
// Co-locate queryKey + queryFn + staleTime so hooks can spread them into
// useQuery() and imperative callers can use .queryKey for cache operations.
//
// References:
// - https://tanstack.com/query/latest/docs/framework/react/guides/query-options
// - https://tkdodo.eu/blog/the-query-options-api
// ---------------------------------------------------------------------------

const QUERY_STALE_TIME_MS = 30_000;

/**
 * A fully drained list as a {@link ConversationListPage}. Every list cache
 * holds the page shape, windowed or not, so the cross-cache helpers in
 * `conversation-cache.ts` never branch on shape; a drained list is simply a
 * page the server has nothing beyond.
 */
async function drainedPage(
  fetchAll: Promise<Conversation[]>,
): Promise<ConversationListPage> {
  return { conversations: await fetchAll, hasMore: false };
}

/**
 * Query options for the foreground conversation list. Spread into
 * `useQuery()` and override `enabled` at the hook level.
 */
export function conversationListOptions(assistantId: string) {
  return queryOptions({
    queryKey: conversationsQueryKey(assistantId),
    queryFn: () => drainedPage(listConversations(assistantId)),
    staleTime: QUERY_STALE_TIME_MS,
  });
}

/**
 * Query options for the background conversation list.
 */
export function backgroundConversationListOptions(assistantId: string) {
  return queryOptions({
    queryKey: backgroundConversationsQueryKey(assistantId),
    queryFn: () => drainedPage(listBackgroundConversations(assistantId)),
    staleTime: QUERY_STALE_TIME_MS,
  });
}

/**
 * Query options for the scheduled conversation list.
 */
export function scheduledConversationListOptions(assistantId: string) {
  return queryOptions({
    queryKey: scheduledConversationsQueryKey(assistantId),
    queryFn: () => drainedPage(listScheduledConversations(assistantId)),
    staleTime: QUERY_STALE_TIME_MS,
  });
}

/**
 * Query options for the archived conversation list.
 */
export function archivedConversationListOptions(assistantId: string) {
  return queryOptions({
    queryKey: archivedConversationsQueryKey(assistantId),
    queryFn: () => drainedPage(listArchivedConversations(assistantId)),
    staleTime: QUERY_STALE_TIME_MS,
  });
}

/**
 * Query options for one sidebar section's conversations.
 *
 * One factory for every section, parameterized by the filter rather than one
 * factory per filter axis: a section can constrain both at once, which a
 * per-axis factory cannot express. Caches independently per
 * `(assistantId, groupId, originChannel)`.
 *
 * The fetch is one page, not a drain (LUM-2444): a cold section costs a
 * single GET, `hasMore` marks the cache as a window, and older rows arrive
 * through `loadMoreSectionConversations` as the user scrolls.
 *
 * The queryFn is *window-preserving*: a windowed cache holds every page the
 * user scrolled in, and a plain refetch (focus past staleTime, the settle
 * invalidation after every placement) that returned page one bare would
 * truncate the window back to 50 rows under the user's scrollbar. Merging
 * the fresh page over the cached window (`mergeListFirstPage`, the same
 * rule the sync refresh uses) makes every refresh path "refresh the top,
 * keep the window". The cache is read through the query function's own
 * context, so the factory stays keyed by request identity alone like its
 * siblings; the read happens after the response so it merges against the
 * freshest rows, and a mutation that lands mid-fetch cancels this query
 * outright (`cancelConversationQueries`), so the merge cannot land on top
 * of an optimistic write.
 */
export function sectionConversationListOptions(
  assistantId: string,
  filter: SectionConversationFilter,
) {
  return queryOptions({
    queryKey: sectionConversationsQueryKey(assistantId, filter),
    queryFn: async ({ client, queryKey }) => {
      const page = await listSectionConversationsFirstPage(assistantId, filter);
      const prev = client.getQueryData<ConversationListPage>(queryKey);
      /* A section page has no daemon pinned-row injection; see
         mergeListFirstPage. */
      return prev
        ? mergeListFirstPage(prev, page, { pinnedInjected: false })
        : page;
    },
    staleTime: QUERY_STALE_TIME_MS,
  });
}

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
