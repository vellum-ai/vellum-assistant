/**
 * Bus consumer for assistant-level resource cache invalidation.
 *
 * Routes `sync_changed` tags (avatar, identity, config, sounds,
 * schedules) and discrete SSE events (`home_feed_updated`,
 * `relationship_state_updated`, `identity_changed`, `avatar_updated`)
 * into TanStack Query cache invalidations.
 *
 * All operations are stateless one-liner invalidations with no
 * debouncing or per-row patching.
 *
 * More complex sync domains (conversations, feature flags) own their
 * own hooks:
 * - `domains/conversations/use-conversation-sync.ts`
 * - `lib/feature-flags/use-feature-flag-bus-sync.ts`
 *
 * References:
 * - EVENT_BUS.md — bus subscription contract
 * - CONVENTIONS.md — domain-first decomposition
 */

import { useQueryClient } from "@tanstack/react-query";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import {
  assistantDaemonConfigQueryKey,
  assistantIdentityQueryKey,
  assistantScheduleRunsQueryKey,
  assistantSchedulesQueryKey,
  assistantSoundsAvailableQueryKey,
  assistantSoundsConfigQueryKey,
  avatarQueryKey,
  HOME_FEED_QUERY_KEY_PREFIX,
  HOME_STATE_QUERY_KEY_PREFIX,
} from "@/lib/sync/query-tags";
import { SYNC_TAGS } from "@/lib/sync/types";

/**
 * Subscribes to assistant-resource sync events via the event bus.
 *
 * Handles `sync_changed` tags for avatar, identity, config, sounds,
 * and schedules, plus discrete event types for home feed/state changes
 * and identity/avatar pushes. These are all stateless invalidations —
 * no reconnect handling needed since the underlying `useQuery` hooks
 * refetch automatically when the query becomes stale.
 */
export function useAssistantResourceSync(
  assistantId: string | null,
  isAssistantActive: boolean,
): void {
  const queryClient = useQueryClient();

  useBusSubscription("sse.event", (event) => {
    if (!assistantId || !isAssistantActive) return;

    switch (event.type) {
      case "sync_changed":
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
          }
        }
        return;

      case "home_feed_updated":
        void queryClient.invalidateQueries({
          queryKey: [HOME_FEED_QUERY_KEY_PREFIX],
        });
        return;

      case "relationship_state_updated":
        void queryClient.invalidateQueries({
          queryKey: [HOME_FEED_QUERY_KEY_PREFIX],
        });
        void queryClient.invalidateQueries({
          queryKey: [HOME_STATE_QUERY_KEY_PREFIX],
        });
        return;

      case "identity_changed":
        void queryClient.invalidateQueries({
          queryKey: assistantIdentityQueryKey(assistantId),
        });
        return;

      case "avatar_updated":
        void queryClient.invalidateQueries({
          queryKey: avatarQueryKey(assistantId),
        });
        return;
    }
  });
}
