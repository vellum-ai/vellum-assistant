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
 * ChatPage.
 *
 * Conversation-list shape changes (`conversationsList` umbrella tag)
 * still trigger a full sidebar refetch. Per-conversation content
 * changes (`conversation:<id>:metadata`) GET-and-patch the single row
 * via `refreshConversationRow`, avoiding the full paginated list
 * drain.
 */

import * as Sentry from "@sentry/react";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { AssistantEvent } from "@/domains/chat/api/event-types";
import { refreshConversationRow } from "@/domains/conversations/conversation-queries";
import { assistantIdentityQueryKey } from "@/hooks/use-assistant-identity-init";
import { ASSISTANT_FLAG_VALUES_QUERY_KEY } from "@/lib/feature-flags/use-assistant-feature-flag-sync";
import { CLIENT_FLAG_QUERY_KEY } from "@/lib/feature-flags/use-client-feature-flag-sync";
import {
  assistantDaemonConfigQueryKey,
  assistantScheduleRunsQueryKey,
  assistantSchedulesQueryKey,
  assistantSoundsAvailableQueryKey,
  assistantSoundsConfigQueryKey,
  avatarQueryKey,
  chatContextQueryKey,
  conversationGroupsQueryKey,
} from "@/lib/sync/query-tags";
import {
  parseConversationSyncTag,
  SYNC_TAGS,
  type SyncChangedEvent,
} from "@/lib/sync/types";
import { useEventBusStore } from "@/stores/event-bus-store";

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
          default: {
            // Per-conversation metadata tags (`conversation:<id>:metadata`)
            // GET-and-patch the single row via `refreshConversationRow`.
            // Shape changes already pair with the `conversationsList`
            // umbrella tag handled above, so we only get here for
            // content-only signals (seen state, title, attention cursor) —
            // a single request per signal instead of the legacy ~14-
            // request paginated drain (`limit=50&offset=0..N` for
            // foreground + background) at a few hundred conversations.
            //
            // `:messages` tags are intentionally ignored here. Refetching
            // the conversation list on every message persist was
            // disproportionate work for fields that the UI tolerates
            // going slightly stale between explicit list fetches.
            // Consumers that need fresh `lastMessageAt` at high frequency
            // bind to the per-conversation message stream directly.
            const parsed = parseConversationSyncTag(tag);
            if (parsed?.resource === "metadata") {
              void refreshConversationRow(
                queryClient,
                assistantId,
                parsed.conversationId,
              ).catch((err: unknown) => {
                Sentry.captureException(err, {
                  level: "warning",
                  tags: { context: "useAssistantSyncStream.refreshRow" },
                  extra: {
                    assistantId,
                    conversationId: parsed.conversationId,
                  },
                });
              });
            }
            break;
          }
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
