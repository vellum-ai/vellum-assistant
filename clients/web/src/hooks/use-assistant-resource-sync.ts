/**
 * Bus consumer for assistant-level resource cache invalidation.
 *
 * Routes `sync_changed` tags (avatar, identity, config, sounds, schedules,
 * apps, plugins) and discrete SSE events (`home_feed_updated`,
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

import { invalidatePluginQueries } from "@/domains/intelligence/plugins/invalidate-plugin-queries";
import {
  configGetQueryKey,
  identityGetQueryKey,
  schedulesGetQueryKey,
  soundsAvailableGetQueryKey,
  soundsConfigGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { getClientId } from "@/lib/telemetry/client-identity";
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
  const pathOpts = { path: { assistant_id: assistantId ?? "" } };

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
                queryKey: identityGetQueryKey(pathOpts),
              });
              break;
            case SYNC_TAGS.assistantConfig:
              void queryClient.invalidateQueries({
                queryKey: configGetQueryKey(pathOpts),
              });
              break;
            case SYNC_TAGS.assistantSounds:
              void queryClient.invalidateQueries({
                queryKey: soundsConfigGetQueryKey(pathOpts),
              });
              void queryClient.invalidateQueries({
                queryKey: soundsAvailableGetQueryKey(pathOpts),
              });
              break;
            case SYNC_TAGS.assistantSchedules:
              void queryClient.invalidateQueries({
                queryKey: schedulesGetQueryKey(pathOpts),
              });
              void queryClient.invalidateQueries({
                queryKey: [{ _id: "schedulesByIdRunsGet", path: { assistant_id: assistantId } }],
              });
              void queryClient.invalidateQueries({
                queryKey: [{ _id: "schedulesUsagesummaryGet", path: { assistant_id: assistantId } }],
              });
              break;
            case SYNC_TAGS.appsList:
              void queryClient.invalidateQueries({
                predicate: (query) => isGeneratedQueryKey(query.queryKey, "appsGet"),
              });
              break;
            case SYNC_TAGS.pluginsList:
              invalidatePluginQueries(queryClient, assistantId);
              break;
          }
        }
        return;

      case "home_feed_updated":
        void queryClient.invalidateQueries({
          predicate: (query) => isGeneratedQueryKey(query.queryKey, "homeFeedGet"),
        });
        return;

      case "relationship_state_updated":
        void queryClient.invalidateQueries({
          predicate: (query) => isGeneratedQueryKey(query.queryKey, "homeFeedGet"),
        });
        void queryClient.invalidateQueries({
          predicate: (query) => isGeneratedQueryKey(query.queryKey, "homeStateGet"),
        });
        return;

      case "identity_changed":
        void queryClient.invalidateQueries({
          queryKey: identityGetQueryKey(pathOpts),
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
      queryKey: identityGetQueryKey(pathOpts),
    });
    void queryClient.invalidateQueries({
      queryKey: configGetQueryKey(pathOpts),
    });
    void queryClient.invalidateQueries({
      queryKey: soundsConfigGetQueryKey(pathOpts),
    });
    void queryClient.invalidateQueries({
      queryKey: soundsAvailableGetQueryKey(pathOpts),
    });
    void queryClient.invalidateQueries({
      queryKey: schedulesGetQueryKey(pathOpts),
    });
    void queryClient.invalidateQueries({
      queryKey: [{ _id: "schedulesByIdRunsGet", path: { assistant_id: assistantId } }],
    });
    void queryClient.invalidateQueries({
      queryKey: [{ _id: "schedulesUsagesummaryGet", path: { assistant_id: assistantId } }],
    });
    void queryClient.invalidateQueries({
      predicate: (query) => isGeneratedQueryKey(query.queryKey, "appsGet"),
    });
    invalidatePluginQueries(queryClient, assistantId);
    void queryClient.invalidateQueries({
      predicate: (query) => isGeneratedQueryKey(query.queryKey, "homeFeedGet"),
    });
    void queryClient.invalidateQueries({
      predicate: (query) => isGeneratedQueryKey(query.queryKey, "homeStateGet"),
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
