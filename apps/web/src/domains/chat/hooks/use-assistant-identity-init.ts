/**
 * Initial assistant-identity hydration for the chat-layout sidebar.
 *
 * The sidebar header (rendered by `ChatLayout`) shows the assistant's
 * name on every route under `/assistant/*` — chat, home, library,
 * contacts, identity. Its data lives in the Zustand
 * `useAssistantIdentityStore`.
 *
 * Without this hook, the store is hydrated only by `ChatPage`'s
 * identity fetch, so direct navigation to any non-chat route (or
 * navigating away from a conversation) leaves the sidebar header
 * showing the "Your Assistant" fallback. This hook fixes that by
 * fetching identity at the layout level so every sibling route
 * inherits a populated sidebar.
 *
 * Mirrors the pattern from `useConversationListInit` (LUM-1732):
 * server state lives in TanStack Query; the Zustand store is kept in
 * sync via a small effect so existing consumers keep their
 * subscription model.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/queries
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchAssistantIdentity } from "@/domains/chat/api/assistant.js";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store.js";
import type { AssistantState } from "@/domains/chat/hooks/use-assistant-lifecycle.js";

export const ASSISTANT_IDENTITY_QUERY_KEY = "assistant-identity" as const;

export function assistantIdentityQueryKey(assistantId: string | null) {
  return [ASSISTANT_IDENTITY_QUERY_KEY, assistantId ?? ""] as const;
}

interface UseAssistantIdentityInitParams {
  assistantId: string | null;
  assistantStateKind: AssistantState["kind"];
}

export function useAssistantIdentityInit({
  assistantId,
  assistantStateKind,
}: UseAssistantIdentityInitParams) {
  const isActive = assistantStateKind === "active" && Boolean(assistantId);

  const identityQuery = useQuery({
    queryKey: assistantIdentityQueryKey(assistantId),
    queryFn: () => fetchAssistantIdentity(assistantId as string),
    enabled: isActive,
    staleTime: 30_000,
  });

  useEffect(() => {
    const data = identityQuery.data;
    // `fetchAssistantIdentity` returns null on transient failures
    // (initializing assistant, unreachable runtime). Don't clobber a
    // good cached name with null — the store is also written by
    // ChatPage's local state and by auth logout, which own clearing.
    if (!data) return;
    useAssistantIdentityStore.getState().setIdentity(
      data.name ?? null,
      data.version ?? null,
    );
  }, [identityQuery.data]);
}
