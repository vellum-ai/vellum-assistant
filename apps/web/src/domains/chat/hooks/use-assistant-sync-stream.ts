/**
 * Bus-consumer that routes assistant-global SSE events into the React
 * Query caches that back avatar, identity, config, sounds, schedules,
 * conversation list, and feature flag values. The underlying SSE
 * connection is owned by `useEventBusInit` at root-layout scope; this
 * hook is mounted on `RootLayout` so flag invalidations propagate on
 * every authenticated route (settings, billing, plugins, etc.).
 *
 * Per-conversation events (text deltas, tool calls, interactions,
 * per-conversation message tags) are ignored here — those remain
 * owned by the conversation-scoped `useEventStream` mounted in
 * ChatPage. Per-conversation metadata/messages sync tags still bump
 * the sidebar list refresh.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { AssistantEvent } from "@/domains/chat/api/event-types.js";
import { assistantIdentityQueryKey } from "@/hooks/use-assistant-identity-init.js";
import { ASSISTANT_FLAG_VALUES_QUERY_KEY } from "@/lib/feature-flags/use-assistant-feature-flag-sync.js";
import { CLIENT_FLAG_QUERY_KEY } from "@/lib/feature-flags/use-client-feature-flag-sync.js";
import {
  assistantDaemonConfigQueryKey,
  assistantScheduleRunsQueryKey,
  assistantSchedulesQueryKey,
  assistantSoundsAvailableQueryKey,
  assistantSoundsConfigQueryKey,
  avatarQueryKey,
  chatContextQueryKey,
  conversationGroupsQueryKey,
} from "@/lib/sync/query-tags.js";
import {
  isConversationMetadataSyncTag,
  SYNC_TAGS,
  type SyncChangedEvent,
} from "@/lib/sync/types.js";
import { useEventBusStore } from "@/stores/event-bus-store.js";

const CONVERSATION_LIST_DEBOUNCE_MS = 250;

/**
 * Subscribes to assistant-global sync events via the event bus.
 *
 * Idempotent across remounts and safe to call when the assistant is not
 * active (returns without subscribing).
 */
export function useAssistantSyncStream(
  assistantId: string | null,
  isAssistantActive: boolean,
): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!assistantId || !isAssistantActive) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleConversationListRefetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void queryClient.invalidateQueries({
          queryKey: chatContextQueryKey(assistantId),
        });
        void queryClient.invalidateQueries({
          queryKey: conversationGroupsQueryKey(assistantId),
        });
      }, CONVERSATION_LIST_DEBOUNCE_MS);
    };

    const handleSyncChanged = (event: SyncChangedEvent) => {
      for (const tag of event.tags) {
        switch (tag) {
          case SYNC_TAGS.assistantAvatar:
            void queryClient.invalidateQueries({
              queryKey: avatarQueryKey(assistantId),
            });
            break;
          case SYNC_TAGS.assistantIdentity:
            void queryClient.invalidateQueries({
              queryKey: assistantIdentityQueryKey(assistantId),
            });
            break;
          case SYNC_TAGS.assistantConfig:
            void queryClient.invalidateQueries({
              queryKey: assistantDaemonConfigQueryKey(assistantId),
            });
            break;
          case SYNC_TAGS.assistantSounds:
            void queryClient.invalidateQueries({
              queryKey: assistantSoundsConfigQueryKey(assistantId),
            });
            void queryClient.invalidateQueries({
              queryKey: assistantSoundsAvailableQueryKey(assistantId),
            });
            break;
          case SYNC_TAGS.assistantSchedules:
            void queryClient.invalidateQueries({
              queryKey: assistantSchedulesQueryKey(assistantId),
            });
            void queryClient.invalidateQueries({
              queryKey: assistantScheduleRunsQueryKey(assistantId),
            });
            break;
          case SYNC_TAGS.conversationsList:
            scheduleConversationListRefetch();
            break;
          case SYNC_TAGS.featureFlagsClient:
            void queryClient.invalidateQueries({
              queryKey: CLIENT_FLAG_QUERY_KEY,
            });
            break;
          case SYNC_TAGS.featureFlagsAssistant:
            void queryClient.invalidateQueries({
              queryKey: [ASSISTANT_FLAG_VALUES_QUERY_KEY],
            });
            break;
          default:
            // Per-conversation metadata tags still bump the sidebar
            // list — every metadata emit already pairs with
            // `conversationsList`, but keep this here as a belt-and-
            // suspenders signal for any future caller that emits
            // metadata in isolation.
            //
            // `:messages` tags intentionally do NOT trigger a list
            // refresh. Refetching the entire paginated conversation
            // list on every message persist (`limit=50&offset=0..N`
            // for both foreground and background variants — ~14
            // requests per write for assistants with a few hundred
            // conversations) was disproportionate work for fields
            // that the UI can tolerate going slightly stale between
            // explicit list fetches. Consumers that need fresh
            // `lastMessageAt`/attention state at high frequency can
            // bind to the per-conversation message stream directly.
            if (isConversationMetadataSyncTag(tag)) {
              scheduleConversationListRefetch();
            }
            break;
        }
      }
    };

    const handleEvent = (event: AssistantEvent) => {
      switch (event.type) {
        case "sync_changed":
          handleSyncChanged(event);
          return;
        case "home_feed_updated":
        case "relationship_state_updated":
          // Broadcast events that mutate home-feed-derived state
          // (home page list + sidebar unread-home indicator). Invalidate
          // by prefix so every home-feed query key for the assistant is
          // refreshed, matching the existing per-conversation handler.
          void queryClient.invalidateQueries({ queryKey: ["home-feed"] });
          return;
        default:
          // All other event types (assistant_text_delta, tool_*,
          // message_*, confirmation_request, etc.) are
          // conversation-scoped and handled by ChatPage's
          // useEventStream. Ignoring them here is intentional.
          return;
      }
    };

    const unsubscribe = useEventBusStore
      .getState()
      .subscribe("sse.event", handleEvent);

    // After a transport reconnect we may have missed `sync_changed`
    // events during the gap. Re-fetch both flag query families so the
    // caches re-converge with the daemon. `cause: "fresh"` is the
    // initial connection — useQuery already fetches on mount, so the
    // extra invalidation would be redundant.
    const unsubscribeOpened = useEventBusStore
      .getState()
      .subscribe("sse.opened", ({ cause }) => {
        if (cause === "fresh") return;
        void queryClient.invalidateQueries({
          queryKey: CLIENT_FLAG_QUERY_KEY,
        });
        void queryClient.invalidateQueries({
          queryKey: [ASSISTANT_FLAG_VALUES_QUERY_KEY],
        });
      });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      unsubscribe();
      unsubscribeOpened();
    };
  }, [assistantId, isAssistantActive, queryClient]);
}
