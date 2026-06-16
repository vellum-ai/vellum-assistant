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
import { captureError } from "@/lib/sentry/capture-error";
import { conversationsGet } from "@/generated/daemon/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import {
  archivedConversationsQueryKey,
  backgroundConversationsQueryKey,
  conversationsQueryKey,
  scheduledConversationsQueryKey,
} from "@/lib/sync/query-tags";
import type { Conversation } from "@/types/conversation-types";
import { isScheduledConversation } from "@/utils/conversation-predicates";
import { toConversation } from "@/utils/conversation-transforms";

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

type FetchConversationListOptions = {
  conversationType?: "background" | "scheduled";
  /**
   * Filter by archive state. Defaults to `"active"` on the daemon side, so
   * omitting this returns non-archived rows only — matching how the sidebar
   * wants to read the list. The Archive page passes `"archived"`.
   */
  archiveStatus?: "active" | "archived" | "all";
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
  const { conversationType, archiveStatus } = options;
  const { data, error, response } = await conversationsGet({
    path: { assistant_id: assistantId },
    query: {
      limit: CONVERSATION_LIST_PAGE_SIZE,
      offset,
      ...(conversationType ? { conversationType } : {}),
      ...(archiveStatus ? { archiveStatus } : {}),
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
 * and sorted. Used by the Archive page, which lists every conversation type
 * together.
 *
 * The background fetch is best-effort: if it fails the foreground list is
 * still returned so the calling surface remains usable.
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

  const foreground = foregroundResult.value;
  let background: Conversation[] = [];
  if (backgroundResult.status === "fulfilled") {
    background = backgroundResult.value;
  } else {
    captureError(backgroundResult.reason, {
      context: `fetchMergedConversationList.background(${archiveStatus})`,
      level: "warning",
      extra: { assistantId },
    });
  }

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
