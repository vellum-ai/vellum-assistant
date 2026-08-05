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
 * transport gap. That sweep is debounced and split into refetch tiers; see
 * `refreshAssistantResources` below.
 *
 * Focus-based refetching (tab visible, Capacitor foregrounding) is NOT
 * handled here — it's configured globally via TQ's `focusManager` in
 * `lib/query-focus-manager.ts`, which covers every query automatically.
 *
 * Tag-driven operations are stateless one-liner invalidations with no
 * per-row patching.
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

import { useEffect, useRef } from "react";
import {
  useQueryClient,
  type InvalidateQueryFilters,
  type QueryClient,
} from "@tanstack/react-query";

import { invalidateMemoryQueries } from "@/domains/intelligence/memory-graph/invalidate-memory-queries";
import { invalidatePluginQueries } from "@/domains/intelligence/plugins/invalidate-plugin-queries";
import {
  configGetQueryKey,
  identityGetQueryKey,
  inferenceProfilesGetQueryKey,
  schedulesGetQueryKey,
  soundsAvailableGetQueryKey,
  soundsConfigGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { getClientId } from "@/lib/telemetry/client-identity";
import { SYNC_TAGS } from "@/lib/sync/types";

/**
 * A reconnect can flap: error, reopen, error, reopen. Collapse a burst into
 * one trailing sweep rather than one per `sse.opened`.
 */
const RECONNECT_SWEEP_DEBOUNCE_MS = 500;

/**
 * Lazy tier marker: mark the cache entry stale without refetching it now.
 * TanStack refetches it the next time an observer mounts or the app refocuses.
 */
const LAZY_REFETCH: InvalidateQueryFilters["refetchType"] = "none";

/**
 * Subscribes to assistant-resource sync events via the event bus.
 *
 * Two bus channels:
 * - `sse.event` — routes `sync_changed` tags (with self-echo
 *   suppression) and discrete event types into TQ cache invalidations
 * - `sse.opened` — on reconnect (non-fresh), invalidates all cached
 *   assistant resources to catch events missed during the transport gap,
 *   as one debounced `refreshAssistantResources` sweep
 */
export function useAssistantResourceSync(
  assistantId: string | null,
  isAssistantActive: boolean,
): void {
  const queryClient = useQueryClient();
  const pathOpts = { path: { assistant_id: assistantId ?? "" } };
  const reconnectSweepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Drop a pending sweep on unmount and when the assistant changes or
  // deactivates, so a queued callback never refreshes against an old
  // assistantId.
  useEffect(() => {
    return () => {
      if (reconnectSweepTimerRef.current) {
        clearTimeout(reconnectSweepTimerRef.current);
        reconnectSweepTimerRef.current = null;
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
        if (event.originClientId && event.originClientId === getClientId()) {
          return;
        }
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
              // The effective profile catalog is derived from config
              // (profiles, default provider), so a config write on any
              // client can change the Language Model card's rows.
              void queryClient.invalidateQueries({
                queryKey: inferenceProfilesGetQueryKey(pathOpts),
              });
              // Memory availability is derived from config (`memory.enabled`,
              // `memory.v3.live`), so a config write on any client can change
              // what the Memory surface must render.
              invalidateMemoryQueries(queryClient, assistantId);
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
                queryKey: [
                  {
                    _id: "schedulesByIdRunsGet",
                    path: { assistant_id: assistantId },
                  },
                ],
              });
              void queryClient.invalidateQueries({
                queryKey: [
                  {
                    _id: "schedulesUsagesummaryGet",
                    path: { assistant_id: assistantId },
                  },
                ],
              });
              break;
            case SYNC_TAGS.appsList:
              void queryClient.invalidateQueries({
                predicate: (query) =>
                  isGeneratedQueryKey(query.queryKey, "appsGet"),
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
          predicate: (query) =>
            isGeneratedQueryKey(query.queryKey, "homeFeedGet"),
        });
        return;

      case "relationship_state_updated":
        void queryClient.invalidateQueries({
          predicate: (query) =>
            isGeneratedQueryKey(query.queryKey, "homeFeedGet"),
        });
        void queryClient.invalidateQueries({
          predicate: (query) =>
            isGeneratedQueryKey(query.queryKey, "homeStateGet"),
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
    if (!assistantId || !isAssistantActive) {
      return;
    }
    if (cause === "fresh") {
      return;
    }
    if (reconnectSweepTimerRef.current) {
      clearTimeout(reconnectSweepTimerRef.current);
    }
    reconnectSweepTimerRef.current = setTimeout(() => {
      reconnectSweepTimerRef.current = null;
      refreshAssistantResources(queryClient, assistantId);
    }, RECONNECT_SWEEP_DEBOUNCE_MS);
  });
}

/**
 * Reconnect catch-up: `sync_changed` events emitted while the transport was
 * down were never delivered, so every assistant-level cache may be stale.
 *
 * Invalidating every family at TanStack's default `refetchType: "active"`
 * fires their GETs all at once, and an iOS foreground is a reconnect. Two
 * tiers instead:
 *
 *   tier      | families                                   | refetchType
 *   ----------|--------------------------------------------|------------
 *   immediate | identity, config, avatar                   | "active"
 *   lazy      | memory x2, sounds x2, schedules x3, apps,  | "none"
 *             | plugins x4, home feed, home state          |
 *
 * The immediate tier is three cheap reads backing chrome that renders whatever
 * view is open. The lazy tier is marked stale but not refetched: each family
 * refetches on the next observer mount, so a view the user never opens costs
 * nothing and a view they do open reads fresh. A lazy view already mounted at
 * reconnect refetches on the next `app.resume`, which TQ's `focusManager`
 * turns into a refetch of every stale mounted query
 * (`lib/query-focus-manager.ts`). That is the same signal that drives a
 * foreground reconnect, so on the dominant path a mounted view has already
 * refetched by the time this sweep runs.
 *
 * A mounted Home view likewise refetches the feed through its own `app.resume`
 * subscription (`domains/home/hooks/use-home-feed-query.ts`); keeping the home
 * families lazy here stops this sweep from double-paying for that refetch.
 */
function refreshAssistantResources(
  queryClient: QueryClient,
  assistantId: string,
): void {
  const pathOpts = { path: { assistant_id: assistantId } };

  // Immediate tier.
  void queryClient.invalidateQueries({
    queryKey: identityGetQueryKey(pathOpts),
  });
  void queryClient.invalidateQueries({
    queryKey: configGetQueryKey(pathOpts),
  });
  void queryClient.invalidateQueries({
    queryKey: avatarQueryKey(assistantId),
  });

  // Lazy tier.
  invalidateMemoryQueries(queryClient, assistantId, {
    refetchType: LAZY_REFETCH,
  });
  void queryClient.invalidateQueries({
    queryKey: soundsConfigGetQueryKey(pathOpts),
    refetchType: LAZY_REFETCH,
  });
  void queryClient.invalidateQueries({
    queryKey: soundsAvailableGetQueryKey(pathOpts),
    refetchType: LAZY_REFETCH,
  });
  void queryClient.invalidateQueries({
    queryKey: schedulesGetQueryKey(pathOpts),
    refetchType: LAZY_REFETCH,
  });
  void queryClient.invalidateQueries({
    queryKey: [
      { _id: "schedulesByIdRunsGet", path: { assistant_id: assistantId } },
    ],
    refetchType: LAZY_REFETCH,
  });
  void queryClient.invalidateQueries({
    queryKey: [
      { _id: "schedulesUsagesummaryGet", path: { assistant_id: assistantId } },
    ],
    refetchType: LAZY_REFETCH,
  });
  void queryClient.invalidateQueries({
    predicate: (query) => isGeneratedQueryKey(query.queryKey, "appsGet"),
    refetchType: LAZY_REFETCH,
  });
  invalidatePluginQueries(queryClient, assistantId, undefined, {
    refetchType: LAZY_REFETCH,
  });
  void queryClient.invalidateQueries({
    predicate: (query) => isGeneratedQueryKey(query.queryKey, "homeFeedGet"),
    refetchType: LAZY_REFETCH,
  });
  void queryClient.invalidateQueries({
    predicate: (query) => isGeneratedQueryKey(query.queryKey, "homeStateGet"),
    refetchType: LAZY_REFETCH,
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
