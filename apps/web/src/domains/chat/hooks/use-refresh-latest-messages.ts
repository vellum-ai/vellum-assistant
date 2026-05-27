
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useRef,
} from "react";

import {
  filterDismissedSurfaces,
} from "@/domains/chat/utils/dismissed-surfaces-storage";
import { fetchLatestHistoryPage } from "@/domains/chat/api/history";
import { fetchSurfaceContent } from "@/domains/chat/api/surfaces";
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
  activeConversationIdRef: MutableRefObject<string | null>;
  messagesRef: MutableRefObject<DisplayMessage[]>;
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  dismissedSurfaceIdsRef: MutableRefObject<Set<string>>;
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
  dismissedSurfaceIdsRef,
  setMessages,
  isStale,
}: {
  fetched: DisplayMessage[];
  assistantId: string;
  conversationId: string;
  dismissedSurfaceIdsRef: MutableRefObject<Set<string>>;
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  isStale: () => boolean;
}): void {
  for (const message of fetched) {
    if (!message.surfaces) continue;
    for (const surface of message.surfaces) {
      if (dismissedSurfaceIdsRef.current.has(surface.surfaceId)) continue;
      void fetchSurfaceContent(
        assistantId,
        surface.surfaceId,
        conversationId,
      ).then((fresh) => {
        if (!fresh) return;
        if (isStale()) return;
        if (dismissedSurfaceIdsRef.current.has(fresh.surfaceId)) return;
        setMessages((prev) => {
          if (isStale()) return prev;
          if (dismissedSurfaceIdsRef.current.has(fresh.surfaceId)) return prev;
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
  activeConversationIdRef,
  messagesRef,
  setMessages,
  dismissedSurfaceIdsRef,
}: UseRefreshLatestMessagesArgs): () => Promise<RefreshLatestOutcome> {
  const refreshTokenRef = useRef(0);
  return useCallback(async (): Promise<RefreshLatestOutcome> => {
    if (!assistantId) return { kind: "no-change" };
    const conversationId = activeConversationIdRef.current;
    if (!conversationId) return { kind: "no-change" };

    const myToken = ++refreshTokenRef.current;
    const isStale = (): boolean =>
      refreshTokenRef.current !== myToken ||
      activeConversationIdRef.current !== conversationId;

    let fetched;
    try {
      fetched = await fetchLatestHistoryPage(assistantId, conversationId);
    } catch (error) {
      return { kind: "error", error };
    }

    if (isStale()) return { kind: "no-change" };

    const filteredMessages = filterDismissedSurfaces(
      fetched.messages,
      dismissedSurfaceIdsRef.current,
    );

    // Snapshot for the outcome report. The setMessages updater below uses
    // its own `prev` to stay consistent with any SSE deltas that landed
    // between the fetch resolving and React applying the update; the merge
    // helper is pure so running it twice is safe.
    const snapshotNext = reconcileDisplayMessagesWithLatestHistory(
      messagesRef.current,
      filteredMessages,
    );
    const outcome = classifyRefreshLatestOutcome(
      messagesRef.current,
      snapshotNext,
    );

    setMessages((prev) => {
      if (isStale()) return prev;
      return reconcileDisplayMessagesWithLatestHistory(prev, filteredMessages);
    });

    // Surfaces can change server-side independently of message content
    // (e.g. a tool re-runs and replaces a render). The history endpoint
    // returns initial surface data; this loop fetches the latest, including
    // any `ui_surface_update` events that landed since.
    refreshSurfacesForFetchedMessages({
      fetched: filteredMessages,
      assistantId,
      conversationId,
      dismissedSurfaceIdsRef,
      setMessages,
      isStale,
    });

    return outcome;
  }, [
    assistantId,
    activeConversationIdRef,
    messagesRef,
    setMessages,
    dismissedSurfaceIdsRef,
  ]);
}
