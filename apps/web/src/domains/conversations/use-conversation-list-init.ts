/**
 * Initial conversation-list hydration for the chat-layout sidebar.
 *
 * The sidebar (rendered by `ChatLayout`) is shared across every route
 * mounted under `/assistant/*` — chat, home, library, contacts,
 * identity. Its data lives in the Zustand `useConversationListStore`.
 *
 * Without this hook, the store stays empty on direct navigation to any
 * non-chat route because the previous loader (`useConversationLoader`)
 * was mounted only inside `ChatPage`. This hook fixes that by fetching
 * the conversation list at the layout level so every sibling route
 * inherits a populated sidebar.
 *
 * Server state lives in TanStack Query per `apps/web/docs/STATE_MANAGEMENT.md`;
 * the Zustand store is kept in sync via a small effect so existing
 * consumers (sidebar, send pipeline, attention tracking) keep their
 * subscription model. As more of the conversation-list slice migrates
 * to Query, this sync layer can shrink.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/queries
 * - https://zustand.docs.pmnd.rs/guides/updating-state
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Sentry from "@sentry/react";

import { fetchGroups } from "@/domains/chat/api/conversations.js";
import { getChatContext } from "@/domains/chat/api/assistant.js";
import { useConversationListStore } from "@/domains/conversations/conversation-list-store.js";
import type { AssistantState } from "@/domains/chat/hooks/use-assistant-lifecycle.js";

export const CHAT_CONTEXT_QUERY_KEY = "chat-context" as const;

export function chatContextQueryKey(assistantId: string | null) {
  return [CHAT_CONTEXT_QUERY_KEY, assistantId ?? ""] as const;
}

interface UseConversationListInitParams {
  assistantId: string | null;
  assistantStateKind: AssistantState["kind"];
  conversationGroupsUI: boolean;
}

export function useConversationListInit({
  assistantId,
  assistantStateKind,
  conversationGroupsUI,
}: UseConversationListInitParams) {
  const isActive = assistantStateKind === "active" && Boolean(assistantId);

  const chatContextQuery = useQuery({
    queryKey: chatContextQueryKey(assistantId),
    queryFn: getChatContext,
    enabled: isActive,
    staleTime: 30_000,
  });

  useEffect(() => {
    const data = chatContextQuery.data;
    if (!data) return;
    useConversationListStore.getState().setConversations(data.conversations);
  }, [chatContextQuery.data]);

  useEffect(() => {
    if (!isActive || !assistantId) return;
    if (!conversationGroupsUI) return;
    let cancelled = false;
    fetchGroups(assistantId)
      .then((groups) => {
        if (!cancelled) {
          useConversationListStore.getState().setGroups(groups);
        }
      })
      .catch((err) => {
        Sentry.captureException(err, {
          level: "warning",
          tags: { context: "fetchGroups.init" },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [isActive, assistantId, conversationGroupsUI]);
}
