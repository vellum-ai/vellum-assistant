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
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
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
  const snapshot = useChatSessionStore.use.snapshot();
  const optimisticSends = useChatSessionStore.use.optimisticSends();
  const dismissedSurfaceIds = useChatSessionStore.use.dismissedSurfaceIds();
  // Client-sync cutover: when on, derive from the materialized snapshot
  // (snapshot ⊕ optimisticSends) instead of cached history ⊕ liveTurn. Off by
  // default — optimistic-send re-homing, queued messages, and confirmation
  // patches are still being migrated onto the new homes (slice 2b).
  const fromSnapshot = useClientFeatureFlagStore.use.clientSyncSnapshotRender();

  return useMemo(() => {
    const base = fromSnapshot ? (snapshot?.messages ?? []) : history;
    const live = fromSnapshot ? optimisticSends : liveTurn;
    // Dismissed surfaces are client state that hides server-sent surface rows;
    // apply it to the base at read time (returns the same ref when nothing is
    // dismissed, so the steady-state union stays referentially stable).
    const visibleBase = filterDismissedSurfaces(base, dismissedSurfaceIds);
    return selectTranscriptMessages(visibleBase, live);
  }, [fromSnapshot, history, liveTurn, snapshot, optimisticSends, dismissedSurfaceIds]);
}
