/**
 * Bus consumer for feature flag cache invalidation.
 *
 * Invalidates client and assistant flag TanStack Query caches on:
 * - `sync_changed` events carrying `featureFlagsClient` or
 *   `featureFlagsAssistant` tags
 * - `sse.opened` reconnects (non-fresh) to catch flag changes
 *   missed during the transport gap
 *
 * References:
 * - EVENT_BUS.md — bus subscription contract
 * - CONVENTIONS.md — domain-first decomposition
 */

import { useQueryClient } from "@tanstack/react-query";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import {
  assistantFlagValuesQueryKey,
  CLIENT_FLAG_QUERY_KEY,
} from "@/lib/sync/query-tags";
import { SYNC_TAGS } from "@/lib/sync/types";
import { getClientId } from "@/lib/telemetry/client-identity";

/**
 * Subscribes to feature-flag-related sync events via the event bus.
 *
 * Handles two bus channels:
 * - `sse.event` — routes `featureFlagsClient` and `featureFlagsAssistant`
 *   tags from `sync_changed` events
 * - `sse.opened` — re-invalidates both flag queries on reconnect so
 *   caches re-converge with the daemon
 */
export function useFeatureFlagBusSync(
  assistantId: string | null,
  isAssistantActive: boolean,
): void {
  const queryClient = useQueryClient();

  useBusSubscription("sse.event", (envelope) => {
    if (!assistantId || !isAssistantActive) return;
    const event = envelope.message;
    if (event.type !== "sync_changed") return;
    if (event.originClientId && event.originClientId === getClientId()) return;
    for (const tag of event.tags) {
      if (tag === SYNC_TAGS.featureFlagsClient) {
        void queryClient.invalidateQueries({
          queryKey: CLIENT_FLAG_QUERY_KEY,
        });
      } else if (tag === SYNC_TAGS.featureFlagsAssistant) {
        void queryClient.invalidateQueries({
          queryKey: assistantFlagValuesQueryKey(assistantId),
        });
      }
    }
  });

  useBusSubscription("sse.opened", ({ cause }) => {
    if (!assistantId || !isAssistantActive) return;
    if (cause === "fresh") return;
    void queryClient.invalidateQueries({
      queryKey: CLIENT_FLAG_QUERY_KEY,
    });
    void queryClient.invalidateQueries({
      queryKey: assistantFlagValuesQueryKey(assistantId),
    });
  });
}
