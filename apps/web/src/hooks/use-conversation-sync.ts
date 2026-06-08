/**
 * Domain-scoped bus consumer for conversation cache invalidation.
 *
 * Routes `conversationsList` umbrella tags, per-conversation
 * `conversation:<id>:metadata` tags, and the `conversation_title_updated`
 * event into TanStack Query cache operations. Debounces list-level
 * invalidations so rapid-fire sync_changed bursts collapse into a
 * single refetch.
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

import { captureError } from "@/lib/sentry/capture-error";
import { type MutableRefObject, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { refreshConversationRow } from "@/utils/conversation-cache-mutations";
import { invalidateConversationQueries, patchConversation } from "@/utils/conversation-cache";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { conversationGroupsQueryKey } from "@/lib/sync/query-tags";
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

  useBusSubscription("sse.event", (envelope) => {
    if (!assistantId || !isAssistantActive) return;
    const event = envelope.message;

    switch (event.type) {
      case "sync_changed":
        handleConversationSyncTags(
          event,
          assistantId,
          queryClient,
          debounceTimerRef,
        );
        return;

      case "conversation_title_updated":
        patchConversation(
          queryClient,
          assistantId,
          event.conversationId,
          { title: event.title },
        );
        return;
    }
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
    void invalidateConversationQueries(queryClient, assistantId);
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
