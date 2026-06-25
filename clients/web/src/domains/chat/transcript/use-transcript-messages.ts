/**
 * The rendered transcript: the union of persisted history and the in-flight
 * turn.
 *
 * History is owned by the TanStack Query cache (`useHistoryPagination`); the
 * in-flight turn is owned by the chat-session store (`liveTurn`). This hook
 * joins them with `selectTranscriptMessages` — overlaying the live turn onto
 * history by message identity, in history order, with no timestamp sort. It is
 * the single read seam every transcript consumer goes through, so the join is
 * defined once.
 *
 * Calling `useHistoryPagination` here is safe alongside the lifecycle hook that
 * also calls it: TanStack Query dedupes observers of the same key onto one
 * cache entry and one in-flight fetch.
 */

import { useMemo } from "react";

import { selectTranscriptMessages } from "@/domains/chat/transcript/select-transcript-messages";
import { useHistoryPagination } from "@/domains/chat/transcript/use-history-pagination";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { filterDismissedSurfaces } from "@/domains/chat/utils/dismissed-surfaces-storage";
import type { DisplayMessage } from "@/domains/chat/types/types";

export function useTranscriptMessages(
  assistantId: string | null,
  conversationId: string | null,
): DisplayMessage[] {
  const { messages: history } = useHistoryPagination({
    assistantId,
    conversationId,
    enabled: !!assistantId && !!conversationId,
  });
  const liveTurn = useChatSessionStore.use.liveTurn();
  const dismissedSurfaceIds = useChatSessionStore.use.dismissedSurfaceIds();

  return useMemo(() => {
    // Dismissed surfaces are client state that hides server-sent surface rows;
    // apply it to history at read time (returns the same ref when nothing is
    // dismissed, so the steady-state union stays referentially stable).
    const visibleHistory = filterDismissedSurfaces(history, dismissedSurfaceIds);
    return selectTranscriptMessages(visibleHistory, liveTurn);
  }, [history, liveTurn, dismissedSurfaceIds]);
}
