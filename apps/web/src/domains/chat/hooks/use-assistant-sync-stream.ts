/**
 * Bus-consumer that routes assistant-global SSE events into the React
 * Query caches that back avatar, identity, config, sounds, schedules,
 * and the conversation list. The underlying SSE connection is owned
 * by `useEventBusInit` at chat-layout scope.
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
  isConversationMessagesSyncTag,
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
          default:
            // Per-conversation message/metadata tags also bump the
            // sidebar list. The per-conversation message fetch itself
            // is owned by ChatPage's stream — we only debounce a list
            // refresh here so the sidebar stays current on every
            // route.
            if (
              isConversationMetadataSyncTag(tag) ||
              isConversationMessagesSyncTag(tag)
            ) {
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

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      unsubscribe();
    };
  }, [assistantId, isAssistantActive, queryClient]);
}
