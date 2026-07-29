/**
 * Bus consumer for feature flag cache invalidation.
 *
 * Invalidates client and assistant flag TanStack Query caches on:
 * - `sync_changed` events carrying `featureFlagsClient` or
 *   `featureFlagsAssistant` tags
 * - `sse.opened` reconnects (non-fresh) to catch flag changes
 *   missed during the transport gap
 *
 * Client-flag invalidations are limited to one request per 30 seconds with
 * one trailing refresh. This bounds reconnect or duplicate-event bursts while
 * preserving an immediate refresh for the first real change.
 *
 * References:
 * - EVENT_BUS.md — bus subscription contract
 * - CONVENTIONS.md — domain-first decomposition
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { assistantFeatureFlagsGetQueryKey } from "@/generated/gateway/@tanstack/react-query.gen";
import { featureFlagsClientFlagValuesRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import { SYNC_TAGS } from "@/lib/sync/types";
import { getClientId } from "@/lib/telemetry/client-identity";

const CLIENT_FLAG_REFRESH_MIN_INTERVAL_MS = 30_000;

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
  const clientRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastClientRefreshAtRef = useRef<number | null>(null);

  useEffect(() => {
    lastClientRefreshAtRef.current = null;
    return () => {
      if (clientRefreshTimerRef.current) {
        clearTimeout(clientRefreshTimerRef.current);
        clientRefreshTimerRef.current = null;
      }
    };
  }, [assistantId, isAssistantActive, queryClient]);

  const invalidateClientFlags = () => {
    const refresh = () => {
      clientRefreshTimerRef.current = null;
      lastClientRefreshAtRef.current = Date.now();
      void queryClient.invalidateQueries(
        {
          queryKey: featureFlagsClientFlagValuesRetrieveQueryKey(),
        },
        // Keep an active request instead of canceling it and starting a
        // replacement. The query function also forwards its abort signal.
        { cancelRefetch: false },
      );
    };
    const lastRefreshAt = lastClientRefreshAtRef.current;
    const elapsed =
      lastRefreshAt === null
        ? CLIENT_FLAG_REFRESH_MIN_INTERVAL_MS
        : Date.now() - lastRefreshAt;
    if (elapsed >= CLIENT_FLAG_REFRESH_MIN_INTERVAL_MS) {
      if (clientRefreshTimerRef.current) {
        clearTimeout(clientRefreshTimerRef.current);
      }
      refresh();
      return;
    }
    if (clientRefreshTimerRef.current) {
      return;
    }
    clientRefreshTimerRef.current = setTimeout(
      refresh,
      CLIENT_FLAG_REFRESH_MIN_INTERVAL_MS - elapsed,
    );
  };

  useBusSubscription("sse.event", (envelope) => {
    if (!assistantId || !isAssistantActive) {
      return;
    }
    const event = envelope.message;
    if (event.type !== "sync_changed") {
      return;
    }
    if (event.originClientId && event.originClientId === getClientId()) {
      return;
    }
    for (const tag of event.tags) {
      if (tag === SYNC_TAGS.featureFlagsClient) {
        invalidateClientFlags();
      } else if (tag === SYNC_TAGS.featureFlagsAssistant) {
        void queryClient.invalidateQueries({
          queryKey: assistantFeatureFlagsGetQueryKey({
            path: { assistant_id: assistantId },
          }),
        });
      }
    }
  });

  useBusSubscription("sse.opened", ({ cause }) => {
    if (!assistantId || !isAssistantActive) {
      return;
    }
    if (cause === "fresh") {
      return;
    }
    invalidateClientFlags();
    void queryClient.invalidateQueries({
      queryKey: assistantFeatureFlagsGetQueryKey({
        path: { assistant_id: assistantId },
      }),
    });
  });
}
