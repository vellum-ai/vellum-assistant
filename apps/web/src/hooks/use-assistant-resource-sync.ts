/**
 * Bus consumer for assistant-level resource cache invalidation.
 *
 * Routes `sync_changed` tags (avatar, identity, identity intro, config,
 * sounds, schedules, apps) and discrete SSE events (`home_feed_updated`,
 * `relationship_state_updated`, `identity_changed`, `avatar_updated`) into
 * TanStack Query cache invalidations.
 *
 * Also handles `sse.opened` (non-fresh) to invalidate cached resources on
 * reconnect — the client may have missed `sync_changed` events during the
 * transport gap.
 *
 * Focus-based refetching (tab visible, Capacitor foregrounding) is NOT
 * handled here — it's configured globally via TQ's `focusManager` in
 * `lib/query-focus-manager.ts`, which covers every query automatically.
 *
 * All operations are stateless one-liner invalidations with no
 * debouncing or per-row patching.
 *
 * More complex sync domains (conversations, feature flags) own their
 * own hooks:
 * - `hooks/use-conversation-sync.ts`
 * - `hooks/use-feature-flag-bus-sync.ts`
 *
 * References:
 * - EVENT_BUS.md — bus subscription contract
 * - CONVENTIONS.md — domain-first decomposition
 */

import { useQueryClient } from "@tanstack/react-query";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { getClientId } from "@/lib/telemetry/client-identity";
import {
  assistantDaemonConfigQueryKey,
  assistantIdentityQueryKey,
  assistantIdentityIntroQueryKey,
  assistantScheduleRunsQueryKey,
  assistantScheduleUsageSummaryQueryKey,
  assistantSchedulesQueryKey,
  assistantSoundsAvailableQueryKey,
  assistantSoundsConfigQueryKey,
  avatarQueryKey,
} from "@/lib/sync/query-tags";
import { SYNC_TAGS } from "@/lib/sync/types";

/**
 * Subscribes to assistant-resource sync events via the event bus.
 *
 * Two bus channels:
 * - `sse.event` — routes `sync_changed` tags (with self-echo
 *   suppression) and discrete event types into TQ cache invalidations
 * - `sse.opened` — on reconnect (non-fresh), invalidates all cached
 *   assistant resources to catch events missed during the transport gap
 */
export function useAssistantResourceSync(
  assistantId: string | null,
  isAssistantActive: boolean
): void {
  const queryClient = useQueryClient();

  useBusSubscription("sse.event", (envelope) => {
    if (!assistantId || !isAssistantActive) return;
    const event = envelope.message;

    switch (event.type) {
      case "sync_changed":
        if (event.originClientId && event.originClientId === getClientId()) return;
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
              void queryClient.invalidateQueries({
                queryKey: assistantIdentityIntroQueryKey(assistantId),
              });
              break;
            case SYNC_TAGS.assistantIdentityIntro:
              void queryClient.invalidateQueries({
                queryKey: assistantIdentityIntroQueryKey(assistantId),
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
              void queryClient.invalidateQueries({
                queryKey: assistantScheduleUsageSummaryQueryKey(assistantId),
              });
              break;
            case SYNC_TAGS.appsList:
              void queryClient.invalidateQueries({
                predicate: (query) => isAppsGetQueryKey(query.queryKey),
              });
              break;
          }
        }
        return;

      case "home_feed_updated":
        void queryClient.invalidateQueries({
          predicate: (query) => isHomeFeedGetQueryKey(query.queryKey),
        });
        return;

      case "relationship_state_updated":
        void queryClient.invalidateQueries({
          predicate: (query) => isHomeFeedGetQueryKey(query.queryKey),
        });
        void queryClient.invalidateQueries({
          predicate: (query) => isHomeStateGetQueryKey(query.queryKey),
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

  useBusSubscription("sse.opened", ({ cause }) => {
    if (!assistantId || !isAssistantActive) return;
    if (cause === "fresh") return;
    // Reconnect — invalidate all assistant-level resource caches so
    // stale data from missed `sync_changed` events gets refreshed.
    void queryClient.invalidateQueries({
      queryKey: avatarQueryKey(assistantId),
    });
    void queryClient.invalidateQueries({
      queryKey: assistantIdentityQueryKey(assistantId),
    });
    void queryClient.invalidateQueries({
      queryKey: assistantIdentityIntroQueryKey(assistantId),
    });
    void queryClient.invalidateQueries({
      queryKey: assistantDaemonConfigQueryKey(assistantId),
    });
    void queryClient.invalidateQueries({
      queryKey: assistantSoundsConfigQueryKey(assistantId),
    });
    void queryClient.invalidateQueries({
      queryKey: assistantSoundsAvailableQueryKey(assistantId),
    });
    void queryClient.invalidateQueries({
      queryKey: assistantSchedulesQueryKey(assistantId),
    });
    void queryClient.invalidateQueries({
      queryKey: assistantScheduleRunsQueryKey(assistantId),
    });
    void queryClient.invalidateQueries({
      queryKey: assistantScheduleUsageSummaryQueryKey(assistantId),
    });
    void queryClient.invalidateQueries({
      predicate: (query) => isAppsGetQueryKey(query.queryKey),
    });
    void queryClient.invalidateQueries({
      predicate: (query) => isHomeFeedGetQueryKey(query.queryKey),
    });
    void queryClient.invalidateQueries({
      predicate: (query) => isHomeStateGetQueryKey(query.queryKey),
    });
  });
}

function isGeneratedQueryKey(
  queryKey: readonly unknown[],
  id: string,
): boolean {
  const firstKeyPart = queryKey[0];
  return (
    firstKeyPart !== null &&
    typeof firstKeyPart === "object" &&
    (firstKeyPart as { _id?: unknown })._id === id
  );
}

function isAppsGetQueryKey(queryKey: readonly unknown[]): boolean {
  return isGeneratedQueryKey(queryKey, "appsGet");
}

function isHomeFeedGetQueryKey(queryKey: readonly unknown[]): boolean {
  return isGeneratedQueryKey(queryKey, "homeFeedGet");
}

function isHomeStateGetQueryKey(queryKey: readonly unknown[]): boolean {
  return isGeneratedQueryKey(queryKey, "homeStateGet");
}
