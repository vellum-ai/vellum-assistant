/**
 * Bus consumer for assistant-level resource cache invalidation.
 *
 * Routes `sync_changed` tags (avatar, identity, config, sounds, schedules,
 * apps, documents, plugins) and discrete SSE events (`home_feed_updated`,
 * `relationship_state_updated`, `identity_changed`, `avatar_updated`) into
 * TanStack Query cache invalidations.
 *
 * Also handles `sse.opened` (non-fresh) to invalidate cached resources on
 * reconnect — the client may have missed `sync_changed` events during the
 * transport gap. That sweep is debounced, and a pending one is flushed rather
 * than dropped when the assistant changes; see `refreshAssistantResources`
 * below.
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
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { invalidateMemoryQueries } from "@/domains/intelligence/memory-graph/invalidate-memory-queries";
import { invalidatePluginQueries } from "@/domains/intelligence/plugins/invalidate-plugin-queries";
import {
  configGetQueryKey,
  configLlmCallsitesGetQueryKey,
  identityGetQueryKey,
  inferenceProfilesGetQueryKey,
  schedulesGetQueryKey,
  soundsAvailableGetQueryKey,
  soundsConfigGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { chooserRowAvatarQueryKeyPrefix } from "@/hooks/use-chooser-row-avatar";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { supersedePlatformAvatar } from "@/hooks/use-platform-avatar-urls";
import { getClientId } from "@/lib/telemetry/client-identity";
import { SYNC_TAGS } from "@/lib/sync/types";

/**
 * A reconnect can flap: error, reopen, error, reopen. Collapse a burst into
 * one trailing sweep rather than one per `sse.opened`.
 */
const RECONNECT_SWEEP_DEBOUNCE_MS = 500;

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

  // Invariant: a scheduled reconnect catch-up is never dropped. On unmount and
  // when the assistant changes or deactivates, the pending sweep is flushed
  // here rather than cancelled, so the transport gap is always reconciled for
  // the assistant it was scheduled for. This closure captures the departing
  // assistantId, and the flush marks stale without refetching, so at worst the
  // catch-up degrades to stale-marking for an assistant nobody observes any
  // more and the next visit reads through.
  useEffect(() => {
    return () => {
      const pendingSweep = reconnectSweepTimerRef.current;
      if (!pendingSweep) {
        return;
      }
      clearTimeout(pendingSweep);
      reconnectSweepTimerRef.current = null;
      if (!assistantId) {
        return;
      }
      refreshAssistantResources(queryClient, assistantId, "none");
    };
  }, [assistantId, isAssistantActive, queryClient]);

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
              onAvatarChanged(queryClient, assistantId);
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
              // The call-site catalog reports each action's winning profile,
              // resolved from config, so a config write on any client can
              // change it. Surfaces treat that winner as authoritative.
              void queryClient.invalidateQueries({
                queryKey: configLlmCallsitesGetQueryKey(pathOpts),
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
            case SYNC_TAGS.documentsList:
              // The assets pill keys by `query.conversationId` and the Library
              // by the assistant path alone, so match on the operation id to
              // cover both key shapes.
              void queryClient.invalidateQueries({
                predicate: (query) =>
                  isGeneratedQueryKey(query.queryKey, "documentsGet"),
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
        onAvatarChanged(queryClient, assistantId);
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
 * An avatar change on the connected assistant. Beyond the query sweep, drops
 * the row's synced `avatarUrl` and platform lookup entry: the platform copy
 * lags the live change, and while set it keeps the chooser's live/cache paths
 * disabled. The reconnect sweep does not do this, since nothing is known to
 * have changed there.
 */
function onAvatarChanged(queryClient: QueryClient, assistantId: string): void {
  supersedePlatformAvatar(queryClient, assistantId);
  invalidateAvatarQueries(queryClient, assistantId);
}

/** The canonical avatar cache plus every chooser row variant for the same id. */
function invalidateAvatarQueries(
  queryClient: QueryClient,
  assistantId: string,
  refetchType?: "active" | "none",
): void {
  void queryClient.invalidateQueries({
    queryKey: avatarQueryKey(assistantId),
    refetchType,
  });
  // Chooser-row queries are disabled for the connected row, so this only
  // marks them stale for when the user switches away and back.
  void queryClient.invalidateQueries({
    queryKey: chooserRowAvatarQueryKeyPrefix(assistantId),
    refetchType: "none",
  });
}

/**
 * Reconnect catch-up: `sync_changed` events emitted while the transport was
 * down were never delivered, so every assistant-level cache may be stale.
 *
 * Every family invalidates at TanStack's default `refetchType: "active"`,
 * which refetches only the queries that currently have an observer. A view
 * nobody has open is marked stale and costs no request until it next mounts;
 * a view that is open refetches now, which is the only way it picks up the
 * `sync_changed` events it missed while the stream was down.
 *
 * `refetchType: "none"` is the departure flush: the sweep still marks every
 * family stale, but never issues a request. The caller uses it for an assistant
 * the user has just left, whose views are unmounting in this same commit.
 *
 * A flapping reconnect would run this fan-out once per `sse.opened`, so the
 * caller collapses a burst into a single trailing sweep.
 */
function refreshAssistantResources(
  queryClient: QueryClient,
  assistantId: string,
  refetchType: "active" | "none" = "active",
): void {
  const pathOpts = { path: { assistant_id: assistantId } };

  void queryClient.invalidateQueries({
    queryKey: identityGetQueryKey(pathOpts),
    refetchType,
  });
  void queryClient.invalidateQueries({
    queryKey: configGetQueryKey(pathOpts),
    refetchType,
  });
  invalidateAvatarQueries(queryClient, assistantId, refetchType);
  invalidateMemoryQueries(queryClient, assistantId, refetchType);
  void queryClient.invalidateQueries({
    queryKey: soundsConfigGetQueryKey(pathOpts),
    refetchType,
  });
  void queryClient.invalidateQueries({
    queryKey: soundsAvailableGetQueryKey(pathOpts),
    refetchType,
  });
  void queryClient.invalidateQueries({
    queryKey: schedulesGetQueryKey(pathOpts),
    refetchType,
  });
  void queryClient.invalidateQueries({
    queryKey: [
      { _id: "schedulesByIdRunsGet", path: { assistant_id: assistantId } },
    ],
    refetchType,
  });
  void queryClient.invalidateQueries({
    queryKey: [
      { _id: "schedulesUsagesummaryGet", path: { assistant_id: assistantId } },
    ],
    refetchType,
  });
  void queryClient.invalidateQueries({
    predicate: (query) => isGeneratedQueryKey(query.queryKey, "appsGet"),
    refetchType,
  });
  void queryClient.invalidateQueries({
    predicate: (query) => isGeneratedQueryKey(query.queryKey, "documentsGet"),
    refetchType,
  });
  invalidatePluginQueries(queryClient, assistantId, undefined, refetchType);
  void queryClient.invalidateQueries({
    predicate: (query) => isGeneratedQueryKey(query.queryKey, "homeFeedGet"),
    refetchType,
  });
  void queryClient.invalidateQueries({
    predicate: (query) => isGeneratedQueryKey(query.queryKey, "homeStateGet"),
    refetchType,
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
