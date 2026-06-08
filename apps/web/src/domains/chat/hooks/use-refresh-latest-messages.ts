
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useRef,
} from "react";

import {
  filterDismissedSurfaces,
} from "@/domains/chat/utils/dismissed-surfaces-storage";
import { fetchLatestHistoryPage } from "@/domains/chat/api/history";
import { fetchSurfaceContent } from "@/domains/chat/api/surfaces";
import { recordServerSeq } from "@/lib/streaming/server-seq";
import { useConversationStore } from "@/stores/conversation-store";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import {
  type DisplayMessage,
  reconcileDisplayMessagesWithLatestHistory,
} from "@/domains/chat/utils/reconcile";

export type RefreshLatestOutcome =
  | { kind: "no-change" }
  | { kind: "new-messages"; count: number }
  | { kind: "merged" }
  | { kind: "error"; error: unknown };

interface UseRefreshLatestMessagesArgs {
  assistantId: string | null;
}

/**
 * Classify the result of a non-destructive latest-history merge.
 *
 * `reconcileDisplayMessagesWithLatestHistory` returns its `current` input by
 * reference when nothing changed, so identity comparison drives `no-change`.
 * A positive length delta means new rows landed at the tail (the common
 * refresh case). A non-positive delta with a different reference means
 * existing rows were merged in place (e.g. a streaming assistant bubble
 * finalized).
 */
export function classifyRefreshLatestOutcome(
  current: readonly DisplayMessage[],
  next: readonly DisplayMessage[],
): RefreshLatestOutcome {
  if (next === current) return { kind: "no-change" };
  const delta = next.length - current.length;
  if (delta > 0) return { kind: "new-messages", count: delta };
  return { kind: "merged" };
}

/**
 * Fetch fresh content for every surface embedded in `fetched`, then patch
 * the corresponding row in the transcript in place. Skips IDs already in
 * the dismissed set both at dispatch time and when the response lands, so
 * a surface dismissed mid-flight can't reappear. The provided `isStale`
 * check is consulted at every async boundary so a refresh superseded by
 * a newer one (or a conversation switch) silently drops its updates.
 */
function refreshSurfacesForFetchedMessages({
  fetched,
  assistantId,
  conversationId,
  setMessages,
  isStale,
}: {
  fetched: DisplayMessage[];
  assistantId: string;
  conversationId: string;
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  isStale: () => boolean;
}): void {
  for (const message of fetched) {
    if (!message.surfaces) continue;
    for (const surface of message.surfaces) {
      if (useChatSessionStore.getState().dismissedSurfaceIds.has(surface.surfaceId)) continue;
      void fetchSurfaceContent(
        assistantId,
        surface.surfaceId,
        conversationId,
      ).then((fresh) => {
        if (!fresh) return;
        if (isStale()) return;
        if (useChatSessionStore.getState().dismissedSurfaceIds.has(fresh.surfaceId)) return;
        setMessages((prev) => {
          if (isStale()) return prev;
          if (useChatSessionStore.getState().dismissedSurfaceIds.has(fresh.surfaceId)) return prev;
          for (let i = prev.length - 1; i >= 0; i--) {
            const row = prev[i]!;
            const idx =
              row.surfaces?.findIndex(
                (s) => s.surfaceId === fresh.surfaceId,
              ) ?? -1;
            if (idx === -1) continue;
            const updated = [...prev];
            const nextSurfaces = [...row.surfaces!];
            nextSurfaces[idx] = {
              ...nextSurfaces[idx]!,
              data: fresh.data,
              title: fresh.title ?? nextSurfaces[idx]!.title,
            };
            updated[i] = { ...row, surfaces: nextSurfaces };
            return updated;
          }
          return prev;
        });
      });
    }
  }
}

/**
 * Non-destructive refresh handler for the chat title chevron's Refresh menu
 * item. Fetches the latest history page for the active conversation and
 * merges it into the current transcript via
 * `reconcileDisplayMessagesWithLatestHistory`. Preserves:
 *   - in-flight streaming assistant bubbles
 *   - optimistic local user rows that haven't been confirmed yet
 *   - paged-in older history outside the latest window
 *   - the live SSE stream (no reconnect)
 *   - composer drafts, attachments, pending interactions, surfaces (data is
 *     refreshed in place rather than torn down)
 *   - scroll position
 *
 * Locally-dismissed surfaces are filtered out of the merged page so a
 * surface the user already resolved can't reappear via a refresh.
 *
 * Concurrent invocations and mid-fetch conversation switches are both
 * dropped silently: every state-mutation point checks a per-invocation
 * monotonic token plus the active conversation key, so only the latest
 * refresh for the conversation that initiated it can commit updates.
 */
export function useRefreshLatestMessages({
  assistantId,
}: UseRefreshLatestMessagesArgs): () => Promise<RefreshLatestOutcome> {
  const setMessages = useChatSessionStore.use.setMessages();
  const refreshTokenRef = useRef(0);
  return useCallback(async (): Promise<RefreshLatestOutcome> => {
    if (!assistantId) return { kind: "no-change" };
    const conversationId = useConversationStore.getState().activeConversationId;
    if (!conversationId) return { kind: "no-change" };

    const myToken = ++refreshTokenRef.current;
    const isStale = (): boolean =>
      refreshTokenRef.current !== myToken ||
      useConversationStore.getState().activeConversationId !== conversationId;

    let fetched;
    try {
      fetched = await fetchLatestHistoryPage(assistantId, conversationId);
    } catch (error) {
      return { kind: "error", error };
    }

    if (isStale()) return { kind: "no-change" };

    // Record the accepted snapshot's seq as the conversation baseline only
    // after the stale-response guard, so a slower out-of-order refresh can't
    // regress the baseline past a newer one that already committed.
    recordServerSeq(conversationId, fetched.seq);

    const filteredMessages = filterDismissedSurfaces(
      fetched.messages,
      useChatSessionStore.getState().dismissedSurfaceIds,
    );

    // Snapshot for the outcome report. The setMessages updater below uses
    // its own `prev` to stay consistent with any SSE deltas that landed
    // between the fetch resolving and React applying the update; the merge
    // helper is pure so running it twice is safe.
    const isProcessing = useConversationStore
      .getState()
      .processingConversationIds.has(conversationId);
    const currentMessages = useChatSessionStore.getState().messages;
    const snapshotNext = reconcileDisplayMessagesWithLatestHistory(
      currentMessages,
      filteredMessages,
      isProcessing,
    );
    const outcome = classifyRefreshLatestOutcome(
      currentMessages,
      snapshotNext,
    );

    setMessages((prev) => {
      if (isStale()) return prev;
      return reconcileDisplayMessagesWithLatestHistory(
        prev,
        filteredMessages,
        isProcessing,
      );
    });

    // Surfaces can change server-side independently of message content
    // (e.g. a tool re-runs and replaces a render). The history endpoint
    // returns initial surface data; this loop fetches the latest, including
    // any `ui_surface_update` events that landed since.
    refreshSurfacesForFetchedMessages({
      fetched: filteredMessages,
      assistantId,
      conversationId,
      setMessages,
      isStale,
    });

    return outcome;
  }, [
    assistantId,
    setMessages,
  ]);
}
