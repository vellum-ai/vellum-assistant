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
import { conversationsGet } from "@/generated/daemon/sdk.gen";
import type { ConversationsGetData } from "@/generated/daemon/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import type { Conversation } from "@/types/conversation-types";
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

/** Prefix key matching all origin-channel conversation caches. */
export function originChannelListPrefix(assistantId: string | null) {
  return [CONVERSATION_LIST_PREFIX, assistantId ?? "", "channel"] as const;
}

/**
 * Key for a specific origin channel's conversation cache. A child of
 * {@link originChannelListPrefix}, so prefix-match invalidation of the
 * `"channel"` segment reaches every per-channel cache automatically.
 */
export function originChannelConversationsQueryKey(
  assistantId: string | null,
  channel: string,
) {
  return [CONVERSATION_LIST_PREFIX, assistantId ?? "", "channel", channel] as const;
}

// ---------------------------------------------------------------------------
// Shared sort comparator
// ---------------------------------------------------------------------------

/** Sort conversations descending by a timestamp field (newest first). */
function byTimestampDesc(
  key: "lastMessageAt" | "archivedAt",
): (a: Conversation, b: Conversation) => number {
  return (a, b) => (b[key] ?? 0) - (a[key] ?? 0);
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
export type OriginChannel = NonNullable<
  ConversationsGetData["query"]
>["originChannel"];

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
};

/** One page of a conversation list plus whether more pages exist. */
export type ConversationListPage = {
  conversations: Conversation[];
  hasMore: boolean;
};

async function fetchConversationListPage(
  assistantId: string,
  offset: number,
  options: FetchConversationListOptions = {},
): Promise<ConversationListPage> {
  const { conversationType, archiveStatus, originChannel } = options;
  const { data, error, response } = await conversationsGet({
    path: { assistant_id: assistantId },
    query: {
      limit: CONVERSATION_LIST_PAGE_SIZE,
      offset,
      ...(conversationType ? { conversationType } : {}),
      ...(archiveStatus ? { archiveStatus } : {}),
      ...(originChannel ? { originChannel } : {}),
    },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to list conversations.");
  if (!response.ok) {
    const msg = extractErrorMessage(error, response, "Failed to list conversations.");
    throw new ApiError(response.status, msg);
  }

  return {
    conversations: (data?.conversations ?? []).map(toConversation),
    hasMore: data?.hasMore ?? false,
  };
}

async function fetchConversationList(
  assistantId: string,
  options: FetchConversationListOptions = {},
): Promise<Conversation[]> {
  const all: Conversation[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < CONVERSATION_LIST_MAX_PAGES; page++) {
    const offset = page * CONVERSATION_LIST_PAGE_SIZE;
    const { conversations, hasMore } = await fetchConversationListPage(
      assistantId,
      offset,
      options,
    );
    for (const conversation of conversations) {
      if (!seen.has(conversation.conversationId)) {
        seen.add(conversation.conversationId);
        all.push(conversation);
      }
    }

    if (!hasMore) break;

    if (conversations.length === 0) break;
  }

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
  const opts: FetchConversationListOptions = archiveStatus === "active" ? {} : { archiveStatus };
  const bgOpts: FetchConversationListOptions = { ...opts, conversationType: "background" };

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
    if (seen.has(conversation.conversationId)) continue;
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
  const { conversations } = await fetchConversationListPage(assistantId, 0);
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
 * Fetch all active (non-archived) conversations for a given origin channel
 * (e.g. `"slack"`, `"telegram"`), sorted newest-first.
 *
 * Each external channel's sidebar section calls this with its own channel ID.
 * Channel sections are naturally bounded (~5-30 items per user), so a flat
 * fetch (all pages) is appropriate. Cached separately per channel under
 * `originChannelConversationsQueryKey`.
 */
export async function listOriginChannelConversations(
  assistantId: string,
  originChannel: NonNullable<OriginChannel>,
): Promise<Conversation[]> {
  const conversations = await fetchConversationList(assistantId, {
    originChannel,
  });
  return [...conversations].sort(byTimestampDesc("lastMessageAt"));
}

/**
 * Fetch all archived conversations for the archive page.
 * Sorted by `archivedAt` descending (most recently archived first).
 */
export async function listArchivedConversations(
  assistantId: string,
): Promise<Conversation[]> {
  return fetchMergedConversationList(assistantId, "archived", "archivedAt");
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
  const page = await fetchConversationListPage(assistantId, 0);
  return {
    ...page,
    conversations: [...page.conversations].sort(byTimestampDesc("lastMessageAt")),
  };
}

/** First page of {@link listBackgroundConversations} (background bucket). */
export async function listBackgroundConversationsFirstPage(
  assistantId: string,
): Promise<ConversationListPage> {
  const page = await fetchConversationListPage(assistantId, 0, {
    conversationType: "background",
  });
  return {
    ...page,
    conversations: page.conversations
      .filter((c) => !isScheduledConversation(c))
      .sort(byTimestampDesc("lastMessageAt")),
  };
}

/** First page of {@link listScheduledConversations} (scheduled bucket). */
export async function listScheduledConversationsFirstPage(
  assistantId: string,
): Promise<ConversationListPage> {
  const page = await fetchConversationListPage(assistantId, 0, {
    conversationType: "scheduled",
  });
  return {
    ...page,
    conversations: [...page.conversations].sort(byTimestampDesc("lastMessageAt")),
  };
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
 * Query options for the foreground conversation list. Spread into
 * `useQuery()` and override `enabled` at the hook level.
 */
export function conversationListOptions(assistantId: string) {
  return queryOptions({
    queryKey: conversationsQueryKey(assistantId),
    queryFn: () => listConversations(assistantId),
    staleTime: QUERY_STALE_TIME_MS,
  });
}

/**
 * Query options for the background conversation list.
 */
export function backgroundConversationListOptions(assistantId: string) {
  return queryOptions({
    queryKey: backgroundConversationsQueryKey(assistantId),
    queryFn: () => listBackgroundConversations(assistantId),
    staleTime: QUERY_STALE_TIME_MS,
  });
}

/**
 * Query options for the scheduled conversation list.
 */
export function scheduledConversationListOptions(assistantId: string) {
  return queryOptions({
    queryKey: scheduledConversationsQueryKey(assistantId),
    queryFn: () => listScheduledConversations(assistantId),
    staleTime: QUERY_STALE_TIME_MS,
  });
}

/**
 * Query options for the archived conversation list.
 */
export function archivedConversationListOptions(assistantId: string) {
  return queryOptions({
    queryKey: archivedConversationsQueryKey(assistantId),
    queryFn: () => listArchivedConversations(assistantId),
    staleTime: QUERY_STALE_TIME_MS,
  });
}

/**
 * Query options for a specific origin channel's conversation list.
 *
 * Generic factory parameterized by channel ID — each sidebar channel section
 * (Slack, Telegram, Email, etc.) uses this with its own channel value. Cached
 * independently per `(assistantId, channel)` tuple.
 */
export function originChannelConversationListOptions(
  assistantId: string,
  channel: NonNullable<OriginChannel>,
) {
  return queryOptions({
    queryKey: originChannelConversationsQueryKey(assistantId, channel),
    queryFn: () => listOriginChannelConversations(assistantId, channel),
    staleTime: QUERY_STALE_TIME_MS,
  });
}
