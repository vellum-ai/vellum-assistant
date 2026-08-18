/**
 * Domain-scoped bus consumer for conversation cache invalidation.
 *
 * Routes `conversationsList` umbrella tags, per-conversation
 * `conversation:<id>:metadata` tags, and the `conversation_title_updated`
 * event into TanStack Query cache operations. Debounces list-level
 * signals so rapid-fire sync_changed bursts collapse into a single
 * first-page window refresh (`refreshConversationListWindows`) rather
 * than a full paginated re-drain — at thousands of conversations the
 * drain is hundreds of sequential GETs, which exhausts the daemon's
 * per-client rate-limit budget during active turns.
 *
 * Also handles SSE reconnect (`sse.opened`) by scheduling the same
 * debounced window refresh to catch events missed during the gap.
 *
 * Per-conversation content events (text deltas, tool calls) are
 * ignored — those remain owned by the conversation-scoped
 * `useEventStream` mounted in ChatPage.
 *
 * References:
 * - EVENT_BUS.md — bus subscription contract
 * - CONVENTIONS.md — domain-first decomposition
 */

import { captureError } from "@/lib/sentry/capture-error";
import { type MutableRefObject, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  refreshConversationListWindows,
  refreshConversationRow,
} from "@/utils/conversation-cache-mutations";
import { patchConversation } from "@/utils/conversation-cache";
import { createConcurrencyLimiter } from "@/utils/concurrency-limiter";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { groupsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  sidebarSectionsQueryKey,
  unreadConversationCountQueryKey,
} from "@/utils/conversation-list-fetchers";
import {
  conversationListQueryFilter,
  isArchivedFilter,
} from "@/utils/conversation-list-keys";
import { getClientId } from "@/lib/telemetry/client-identity";
import {
  parseConversationSyncTag,
  SYNC_TAGS,
  type SyncChangedEvent,
} from "@/lib/sync/types";

const CONVERSATION_LIST_DEBOUNCE_MS = 250;

/**
 * Cap concurrent per-conversation GET requests triggered by metadata
 * sync tags. A mark-all-read on 2000 conversations emits 2000 metadata
 * tags; without a cap every tag fires a GET /v1/conversations/:id in
 * parallel, blowing the 300 req/min rate limit.
 *
 * Excess calls are dropped. For events that include `conversationsList`
 * (shape-changing: create, delete, reorder), the debounced first-page
 * window refresh reconciles dropped rows. For metadata-only events
 * (seen_changed), dropped rows stay stale until the next
 * reconnect/refresh — acceptable as a rate-limit guard. The long-term
 * fix is a typed event with inline state so the client can patch the
 * cache without a GET.
 */
const MAX_CONCURRENT_ROW_REFRESHES = 6;

/**
 * Subscribes to conversation-related sync events via the event bus.
 *
 * Handles two bus channels:
 * - `sse.event` — routes `conversationsList` and `conversation:<id>:metadata`
 *   tags from `sync_changed` events
 * - `sse.opened` — schedules a debounced first-page window refresh on
 *   reconnect to catch events missed during the transport gap
 */
export function useConversationSync(
  assistantId: string | null,
  isAssistantActive: boolean,
): void {
  const queryClient = useQueryClient();
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unreadCountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Clear pending debounces when the assistant changes or deactivates
  // so stale callbacks never fire with an old assistantId.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (unreadCountTimerRef.current) {
        clearTimeout(unreadCountTimerRef.current);
        unreadCountTimerRef.current = null;
      }
    };
  }, [assistantId, isAssistantActive]);

  useBusSubscription("sse.event", (envelope) => {
    if (!assistantId || !isAssistantActive) {
      return;
    }
    const event = envelope.message;

    switch (event.type) {
      case "sync_changed":
        // Self-echo suppression. The daemon's hub already skips the
        // originating SSE subscriber when it can match the origin
        // client id; this catches any sync_changed that still surfaces
        // (e.g. a reconnect re-delivering a queued event).
        if (event.originClientId && event.originClientId === getClientId()) {
          return;
        }
        handleConversationSyncTags(
          event,
          assistantId,
          queryClient,
          debounceTimerRef,
          unreadCountTimerRef,
        );
        return;

      case "conversation_title_updated":
        patchConversation(queryClient, assistantId, event.conversationId, {
          title: event.title,
        });
        return;
    }
  });

  useBusSubscription("sse.opened", ({ cause }) => {
    if (!assistantId || !isAssistantActive) {
      return;
    }
    if (cause === "fresh") {
      return;
    }
    scheduleConversationListRefetch(queryClient, assistantId, debounceTimerRef);
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Module-scoped concurrency-limited row refresher. Shared across all
 * hook instances (only one exists — RootLayout), but the module scope
 * ensures the active-count survives React strict-mode double-invoke.
 */
const limitedRefreshConversationRow = createConcurrencyLimiter(
  async (
    queryClient: ReturnType<typeof useQueryClient>,
    assistantId: string,
    conversationId: string,
  ) => {
    await refreshConversationRow(queryClient, assistantId, conversationId);
  },
  MAX_CONCURRENT_ROW_REFRESHES,
);

/**
 * Run `task` after {@link CONVERSATION_LIST_DEBOUNCE_MS}, replacing whatever
 * run is already pending on `timerRef`.
 *
 * Every scheduler here collapses a burst: sync signals arrive one per
 * conversation (a bulk mark-read on another client emits hundreds), and each
 * burst should cost one refetch rather than one per event.
 */
function scheduleDebounced(
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
  task: () => void,
): void {
  if (timerRef.current) {
    clearTimeout(timerRef.current);
  }
  timerRef.current = setTimeout(() => {
    timerRef.current = null;
    task();
  }, CONVERSATION_LIST_DEBOUNCE_MS);
}

function scheduleConversationListRefetch(
  queryClient: ReturnType<typeof useQueryClient>,
  assistantId: string,
  debounceTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
): void {
  scheduleDebounced(debounceTimerRef, () => {
    // One first-page GET per populated list cache, including every
    // per-section cache, never a full paginated drain (see
    // refreshConversationListWindows). Sections must NOT be prefix-
    // invalidated here instead: a section refetches by draining all of its
    // pages, so that costs a full drain per mounted section per signal,
    // which is the exact cost this window refresh exists to avoid. The
    // helper itself invalidates the caches it cannot merge (tracked but
    // holding no data, e.g. a failed first fetch), so a signal is still
    // the retry path for a section stranded on its derived fallback.
    void refreshConversationListWindows(queryClient, assistantId).catch(
      (err: unknown) => {
        captureError(err, {
          context: "useConversationSync.refreshListWindows",
          bestEffort: true,
          extra: { assistantId },
        });
      },
    );
    // The archived lists stay on plain invalidation: they order by
    // `archivedAt` while the window refresh merges on a recency axis, and
    // they are mounted only while the archive view is open, so invalidation
    // refetches nothing until then. Groups are a single unpaginated GET.
    void queryClient.invalidateQueries(
      conversationListQueryFilter(assistantId, isArchivedFilter),
    );
    void queryClient.invalidateQueries({
      queryKey: groupsGetQueryKey({
        path: { assistant_id: assistantId ?? "" },
      }),
    });
    void queryClient.invalidateQueries({
      queryKey: unreadConversationCountQueryKey(assistantId),
    });
    // Section existence and badge counts change with the list shape; the
    // index is one cheap GET, so it rides the same debounced signal.
    void queryClient.invalidateQueries({
      queryKey: sidebarSectionsQueryKey(assistantId),
    });
  });
}

/**
 * Debounced invalidation of the server-side unread-count cache.
 *
 * Seen-state changes and newly landed assistant replies surface as
 * per-conversation `conversation:<id>:metadata` tags without a
 * `conversationsList` umbrella tag, so the count must refetch on metadata
 * signals too. It runs on its own timer so a burst of metadata tags does not
 * keep pushing back the list refresh (and vice versa).
 */
function scheduleUnreadCountRefetch(
  queryClient: ReturnType<typeof useQueryClient>,
  assistantId: string,
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
): void {
  scheduleDebounced(timerRef, () => {
    void queryClient.invalidateQueries({
      queryKey: unreadConversationCountQueryKey(assistantId),
    });
    // Seen-state changes move per-section unread, and the index carries
    // those badges, so it refetches on the same metadata-driven timer.
    void queryClient.invalidateQueries({
      queryKey: sidebarSectionsQueryKey(assistantId),
    });
  });
}

function handleConversationSyncTags(
  event: SyncChangedEvent,
  assistantId: string,
  queryClient: ReturnType<typeof useQueryClient>,
  debounceTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
  unreadCountTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
): void {
  for (const tag of event.tags) {
    if (tag === SYNC_TAGS.conversationsList) {
      scheduleConversationListRefetch(
        queryClient,
        assistantId,
        debounceTimerRef,
      );
    } else {
      // Per-conversation metadata tags (`conversation:<id>:metadata`)
      // GET-and-patch the single row via `refreshConversationRow`.
      // `:messages` tags are intentionally ignored — refetching the
      // conversation list on every message persist is disproportionate
      // work for fields the UI tolerates going slightly stale.
      const parsed = parseConversationSyncTag(tag);
      if (parsed?.resource === "metadata") {
        scheduleUnreadCountRefetch(
          queryClient,
          assistantId,
          unreadCountTimerRef,
        );
        void limitedRefreshConversationRow(
          queryClient,
          assistantId,
          parsed.conversationId,
        ).catch((err: unknown) => {
          captureError(err, {
            context: "useConversationSync.refreshRow",
            bestEffort: true,
            extra: {
              assistantId,
              conversationId: parsed.conversationId,
            },
          });
        });
      }
    }
  }
}
