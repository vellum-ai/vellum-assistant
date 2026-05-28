/**
 * Domain-scoped bus consumer for conversation cache invalidation.
 *
 * Routes `conversationsList` umbrella tags and per-conversation
 * `conversation:<id>:metadata` tags into TanStack Query cache
 * operations. Debounces list-level invalidations so rapid-fire
 * sync_changed bursts collapse into a single refetch.
 *
 * Also handles SSE reconnect (`sse.opened`) by scheduling a debounced
 * conversation list refetch to catch events missed during the gap.
 *
 * Per-conversation content events (text deltas, tool calls) are
 * ignored — those remain owned by the conversation-scoped
 * `useEventStream` mounted in ChatPage.
 *
 * References:
 * - EVENT_BUS.md — bus subscription contract
 * - CONVENTIONS.md — domain-first decomposition
 */

import * as Sentry from "@sentry/react";
import { type MutableRefObject, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  conversationGroupsQueryKey,
  refreshConversationRow,
} from "@/domains/conversations/conversation-queries";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { conversationsQueryKey } from "@/lib/sync/query-tags";
import {
  parseConversationSyncTag,
  SYNC_TAGS,
  type SyncChangedEvent,
} from "@/lib/sync/types";

const CONVERSATION_LIST_DEBOUNCE_MS = 250;

/**
 * Subscribes to conversation-related sync events via the event bus.
 *
 * Handles two bus channels:
 * - `sse.event` — routes `conversationsList` and `conversation:<id>:metadata`
 *   tags from `sync_changed` events
 * - `sse.opened` — schedules a debounced list refetch on reconnect to
 *   catch events missed during the transport gap
 */
export function useConversationSync(
  assistantId: string | null,
  isAssistantActive: boolean,
): void {
  const queryClient = useQueryClient();
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear pending debounce when the assistant changes or deactivates
  // so stale callbacks never fire with an old assistantId.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [assistantId, isAssistantActive]);

  useBusSubscription("sse.event", (event) => {
    if (!assistantId || !isAssistantActive) return;
    if (event.type !== "sync_changed") return;
    handleConversationSyncTags(
      event,
      assistantId,
      queryClient,
      debounceTimerRef,
    );
  });

  useBusSubscription("sse.opened", ({ cause }) => {
    if (!assistantId || !isAssistantActive) return;
    if (cause === "fresh") return;
    scheduleConversationListRefetch(
      queryClient,
      assistantId,
      debounceTimerRef,
    );
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function scheduleConversationListRefetch(
  queryClient: ReturnType<typeof useQueryClient>,
  assistantId: string,
  debounceTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
): void {
  if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
  debounceTimerRef.current = setTimeout(() => {
    debounceTimerRef.current = null;
    void queryClient.invalidateQueries({
      queryKey: conversationsQueryKey(assistantId),
    });
    void queryClient.invalidateQueries({
      queryKey: conversationGroupsQueryKey(assistantId),
    });
  }, CONVERSATION_LIST_DEBOUNCE_MS);
}

function handleConversationSyncTags(
  event: SyncChangedEvent,
  assistantId: string,
  queryClient: ReturnType<typeof useQueryClient>,
  debounceTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
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
        void refreshConversationRow(
          queryClient,
          assistantId,
          parsed.conversationId,
        ).catch((err: unknown) => {
          Sentry.captureException(err, {
            level: "warning",
            tags: { context: "useConversationSync.refreshRow" },
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
