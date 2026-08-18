/**
 * The two server answers a cold-load landing needs, each a single-row read.
 *
 * A cold load with nothing selected (no conversation in the URL, no
 * in-memory selection, no draft) resumes the last-viewed conversation if it
 * is still selectable, else lands on the newest foreground conversation.
 * Both are questions about one row, so both are answered by one request
 * each: the last-viewed row by id, and the newest row as page one of the
 * foreground list with `limit: 1`. Neither waits on the drained foreground
 * list, whose length grows with the account and whose readers are elsewhere.
 *
 * The drained list is still consulted when it already holds data (a warm
 * cache from an earlier mount), because reading it costs nothing.
 */

import type { QueryClient } from "@tanstack/react-query";

import { conversationsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  isStoredConversationSelectable,
  type SelectableConversation,
} from "@/domains/chat/utils/conversation-selection";
import type { ConversationListPage } from "@/utils/conversation-list-fetchers";
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
   * The newest active foreground conversation's id, or `null` when the
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

/**
 * The newest active foreground conversation's id.
 *
 * Reads the drained foreground cache when it already holds rows (free), else
 * asks the server for page one with `limit: 1`. The route orders by recency
 * and defaults to active, standard conversations, so the first row is the
 * answer; the pinned rows the daemon appends to an unfiltered page one come
 * after it, never before.
 */
async function fetchLatestForegroundId(
  queryClient: QueryClient,
  assistantId: string,
): Promise<string | null> {
  const cached = queryClient.getQueryData<ConversationListPage>(
    conversationListQueryKey(assistantId),
  );
  if (cached && cached.conversations.length > 0) {
    return cached.conversations[0]?.conversationId ?? null;
  }
  const page = await queryClient.fetchQuery({
    ...conversationsGetOptions({
      path: { assistant_id: assistantId },
      query: { limit: 1 },
    }),
    staleTime: 0,
    retry: false,
  });
  return page.conversations[0]?.id ?? null;
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
