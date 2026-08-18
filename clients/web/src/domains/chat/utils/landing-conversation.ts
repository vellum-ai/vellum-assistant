/**
 * The two server answers a cold-load landing needs, each a single-row
 * question.
 *
 * A cold load with nothing selected (no conversation in the URL, no
 * in-memory selection, no draft) resumes the last-viewed conversation if it
 * is still selectable, else lands on the newest selectable foreground
 * conversation. The last-viewed row is read by id; the newest is the first
 * selectable row of the foreground list's page one, read through the app's
 * own page fetcher so nothing lands in the query cache under the list prefix
 * (every `conversationsGet` key is a list cache to the prefix scanners, and
 * this read is not one). Neither waits on the drained foreground list, whose
 * length grows with the account and whose readers are elsewhere.
 *
 * The drained list is still consulted when it already holds rows (a warm
 * cache from an earlier mount), because reading it costs nothing; the same
 * selectability rule applies to it, since an optimistic archive can leave an
 * archived row in that cache until the settle refetch.
 *
 * Callers gate this on the daemon preconditions every list query honors
 * (`useCanQueryDaemon`). The resolution runs through `queryClient.fetchQuery`
 * so it gets the app's retry policy (transient 5xx and network errors retry
 * with backoff, 4xx do not) and de-duplicates concurrent callers, exactly as
 * a list query does; `gcTime: 0` keeps the answer out of the cache once
 * delivered.
 */

import type { QueryClient } from "@tanstack/react-query";

import {
  isStoredConversationSelectable,
  type SelectableConversation,
} from "@/domains/chat/utils/conversation-selection";
import type { Conversation } from "@/types/conversation-types";
import {
  CONVERSATION_LIST_PAGE_SIZE,
  type ConversationListPage,
  listConversationsFirstPage,
  listConversationsPage,
} from "@/utils/conversation-list-fetchers";
import { conversationListQueryKey } from "@/utils/conversation-list-keys";
import {
  ConversationNotFoundError,
  fetchConversationDetail,
} from "@/utils/fetch-conversation-detail";

export interface LandingConversation {
  /**
   * The stored last-viewed conversation as the server has it, or `null` when
   * nothing was stored or the server no longer has it.
   */
  storedConversation: SelectableConversation | null;
  /**
   * The newest selectable foreground conversation's id, or `null` when the
   * assistant has none.
   */
  latestForegroundId: string | null;
}

/**
 * The stored last-viewed row by id. A 404 is an answer (the conversation is
 * gone), not a failure.
 */
async function fetchStoredConversation(
  queryClient: QueryClient,
  assistantId: string,
  storedConversationId: string | null,
): Promise<SelectableConversation | null> {
  if (!storedConversationId) {
    return null;
  }
  try {
    return await fetchConversationDetail(
      queryClient,
      assistantId,
      storedConversationId,
    );
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      return null;
    }
    throw error;
  }
}

function firstSelectable(rows: Conversation[]): Conversation | undefined {
  return rows.find(isStoredConversationSelectable);
}

/**
 * The newer of two candidate rows by recency, either possibly absent.
 * Recency is `lastMessageAt`, the axis every list read is ordered on.
 */
function newerOf(
  a: Conversation | undefined,
  b: Conversation | undefined,
): Conversation | undefined {
  if (!a || !b) {
    return a ?? b;
  }
  return (b.lastMessageAt ?? 0) > (a.lastMessageAt ?? 0) ? b : a;
}

/**
 * How far past page one the newest-row search looks: the 200 newest rows.
 * Beyond that the landing is the assistant itself (a new chat is one click
 * away), so cold boot stays bounded on an account whose newest rows are all
 * background runs filed in custom groups, rather than scanning to the first
 * chat wherever it sits.
 */
const LANDING_MAX_PAGES = 4;

/**
 * The newest selectable foreground conversation's id.
 *
 * Reads the drained foreground cache when it already holds rows (free), else
 * page one of the foreground list, and later pages only while page one held
 * no selectable row and the server has more, up to {@link LANDING_MAX_PAGES}:
 * the route's standard listing admits background runs filed in custom
 * groups, so the first row is not always a chat. One request in the
 * ordinary case, never more than four.
 */
async function fetchLatestForegroundId(
  queryClient: QueryClient,
  assistantId: string,
): Promise<string | null> {
  const cached = queryClient.getQueryData<ConversationListPage>(
    conversationListQueryKey(assistantId),
  );
  if (cached && cached.conversations.length > 0) {
    return firstSelectable(cached.conversations)?.conversationId ?? null;
  }
  const first = await listConversationsFirstPage(assistantId, {}, "landing");
  /* An unfiltered page one is the paginated window plus every pinned row
     the daemon appends beyond it, sorted together by recency. An appended
     pin is older than the whole window, so it may only win against what
     later pages hold, never pre-empt them: a selectable row inside the
     window is the answer outright; otherwise the pages after the window are
     searched and the newest selectable of those and the appended pins is
     the answer. Without this an old pinned chat below fifty unselectable
     rows would beat a newer chat sitting at the top of page two. */
  const unpinned = first.conversations.filter((c) => c.isPinned !== true);
  const cutoff =
    unpinned.length > 0
      ? Math.min(...unpinned.map((c) => c.lastMessageAt ?? 0))
      : Number.NEGATIVE_INFINITY;
  const inWindow = first.conversations.filter(
    (c) => (c.lastMessageAt ?? 0) >= cutoff,
  );
  const appended = first.conversations.filter(
    (c) => (c.lastMessageAt ?? 0) < cutoff,
  );
  const inWindowFound = firstSelectable(inWindow);
  if (inWindowFound) {
    return inWindowFound.conversationId;
  }
  let found = firstSelectable(appended);
  let page = first;
  /* Advance by the server's page size, not by rows received, for the same
     reason: page one is longer than the window. */
  for (
    let pageIndex = 1;
    pageIndex < LANDING_MAX_PAGES &&
    page.hasMore &&
    page.conversations.length > 0;
    pageIndex += 1
  ) {
    page = await listConversationsPage(
      assistantId,
      {},
      pageIndex * CONVERSATION_LIST_PAGE_SIZE,
    );
    const later = firstSelectable(page.conversations);
    if (later) {
      found = newerOf(found, later);
      break;
    }
  }
  return found?.conversationId ?? null;
}

async function lookUpLanding(
  queryClient: QueryClient,
  assistantId: string,
  storedConversationId: string | null,
): Promise<LandingConversation> {
  const storedConversation = await fetchStoredConversation(
    queryClient,
    assistantId,
    storedConversationId,
  );
  if (
    storedConversation &&
    isStoredConversationSelectable(storedConversation)
  ) {
    return { storedConversation, latestForegroundId: null };
  }
  return {
    storedConversation,
    latestForegroundId: await fetchLatestForegroundId(queryClient, assistantId),
  };
}

/**
 * Resolve what a cold load should land on. The stored row is checked first
 * and the newest row fetched only when it is needed, so the common case (the
 * last-viewed conversation is still there) costs one request.
 *
 * Not a server resource, so not a generated key: this is an in-app
 * computation run through TanStack for its retry policy and dedupe.
 */
export function resolveLandingConversation(
  queryClient: QueryClient,
  assistantId: string,
  storedConversationId: string | null,
): Promise<LandingConversation> {
  return queryClient.fetchQuery({
    queryKey: ["cold-boot-landing", assistantId, storedConversationId],
    queryFn: () =>
      lookUpLanding(queryClient, assistantId, storedConversationId),
    staleTime: 0,
    gcTime: 0,
  });
}
