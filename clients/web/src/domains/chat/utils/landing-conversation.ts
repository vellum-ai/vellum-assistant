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
 * (`useCanQueryDaemon`); it does not retry, so a waking pod's 503 must not
 * reach it.
 */

import type { QueryClient } from "@tanstack/react-query";

import {
  isStoredConversationSelectable,
  type SelectableConversation,
} from "@/domains/chat/utils/conversation-selection";
import type { Conversation } from "@/types/conversation-types";
import {
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

function firstSelectableId(rows: Conversation[]): string | null {
  return rows.find(isStoredConversationSelectable)?.conversationId ?? null;
}

/**
 * The newest selectable foreground conversation's id.
 *
 * Reads the drained foreground cache when it already holds rows (free), else
 * page one of the foreground list, and later pages only while page one held
 * no selectable row and the server has more: the route's standard listing
 * admits background runs filed in custom groups, so the first row is not
 * always a chat. One request in the ordinary case.
 */
async function fetchLatestForegroundId(
  queryClient: QueryClient,
  assistantId: string,
): Promise<string | null> {
  const cached = queryClient.getQueryData<ConversationListPage>(
    conversationListQueryKey(assistantId),
  );
  if (cached && cached.conversations.length > 0) {
    return firstSelectableId(cached.conversations);
  }
  let page = await listConversationsFirstPage(assistantId);
  let offset = page.conversations.length;
  let found = firstSelectableId(page.conversations);
  while (found === null && page.hasMore && page.conversations.length > 0) {
    page = await listConversationsPage(assistantId, {}, offset);
    offset += page.conversations.length;
    found = firstSelectableId(page.conversations);
  }
  return found;
}

/**
 * Resolve what a cold load should land on. The stored row is checked first
 * and the newest row fetched only when it is needed, so the common case (the
 * last-viewed conversation is still there) costs one request.
 */
export async function resolveLandingConversation(
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
