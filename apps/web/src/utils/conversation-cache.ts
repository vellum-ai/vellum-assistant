/**
 * Low-level read/write helpers over the conversations query cache (a flat
 * `Conversation[]` stored under `conversationsQueryKey`).
 *
 * These primitives are shared cross-domain — the conversations domain's
 * higher-level mutations build on `updateConversationsCache`, attention
 * tracking reads the list, and the chat stream handlers patch a row's
 * `isProcessing` snapshot on terminal events. They live at the top level
 * so neither domain reaches into the other; `queryClient.setQueryData` /
 * `getQueryData` is an implementation detail callers shouldn't repeat.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/updates-from-mutation-responses
 */

import type { QueryClient } from "@tanstack/react-query";

import { conversationsQueryKey } from "@/lib/sync/query-tags";
import type { Conversation } from "@/types/conversation-types";

export function updateConversationsCache(
  queryClient: QueryClient,
  assistantId: string | null,
  updater: (conversations: Conversation[]) => Conversation[],
): void {
  queryClient.setQueryData<Conversation[]>(
    conversationsQueryKey(assistantId),
    (prev) => {
      const list = prev ?? [];
      const next = updater(list);
      if (next === list) return prev;
      return next;
    },
  );
}

/**
 * Read a single conversation from the conversations query cache. Used by
 * imperative callers (send pipeline, attention tracking) that need the
 * current value without subscribing to re-renders.
 */
export function findConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  key: string,
): Conversation | undefined {
  const list =
    queryClient.getQueryData<Conversation[]>(
      conversationsQueryKey(assistantId),
    ) ?? [];
  return list.find((c) => c.conversationId === key);
}

/**
 * Read all conversations from the conversations query cache. Returns an
 * empty array when the query hasn't populated yet.
 */
export function getConversations(
  queryClient: QueryClient,
  assistantId: string | null,
): Conversation[] {
  return (
    queryClient.getQueryData<Conversation[]>(
      conversationsQueryKey(assistantId),
    ) ?? []
  );
}

/**
 * Immutably patch the conversation matching `key`, leaving all others
 * untouched. No-op when the key is not in the cache.
 */
export function patchConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  key: string,
  patch: Partial<Conversation>,
): void {
  updateConversationsCache(queryClient, assistantId, (conversations) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.conversationId !== key) return c;
      changed = true;
      return { ...c, ...patch };
    });
    return changed ? next : conversations;
  });
}
