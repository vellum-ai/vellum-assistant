/**
 * Bus consumer for feature flag cache invalidation.
 *
 * Invalidates client and assistant flag TanStack Query caches on:
 * - `sync_changed` events carrying `featureFlagsClient` or
 *   `featureFlagsAssistant` tags
 * - the initial `sse.opened` to catch client flag changes before the stream
 *   established, plus reconnects to catch changes during transport gaps
 *
 * Client-flag signals are limited to one refresh per 30 seconds with one
 * trailing refresh. A signal that races an active fetch queues one serialized
 * follow-up after success. Failure schedules one cadence-bound trailing
 * attempt, preserving correctness without overlapping requests.
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
 * - `sse.opened` — catches up client flags when the stream first establishes
 *   and re-invalidates both flag queries on reconnect
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
  const clientRefreshQueuedAfterFetchRef = useRef(false);
  const clientRefreshGenerationRef = useRef(0);

  useEffect(() => {
    const generation = clientRefreshGenerationRef.current + 1;
    clientRefreshGenerationRef.current = generation;
    lastClientRefreshAtRef.current = null;
    clientRefreshQueuedAfterFetchRef.current = false;
    return () => {
      if (clientRefreshGenerationRef.current === generation) {
        clientRefreshGenerationRef.current += 1;
      }
      clientRefreshQueuedAfterFetchRef.current = false;
      if (clientRefreshTimerRef.current) {
        clearTimeout(clientRefreshTimerRef.current);
        clientRefreshTimerRef.current = null;
      }
    };
  }, [assistantId, isAssistantActive, queryClient]);

  const invalidateClientFlags = () => {
    const refresh = () => {
      clientRefreshTimerRef.current = null;
      const generation = clientRefreshGenerationRef.current;
      const queryKey = featureFlagsClientFlagValuesRetrieveQueryKey();
      const wasFetching =
        queryClient.isFetching({ queryKey, exact: true, type: "active" }) > 0;
      lastClientRefreshAtRef.current = Date.now();
      const invalidation = queryClient.invalidateQueries(
        {
          queryKey,
        },
        // Keep an active request instead of canceling it and starting a
        // replacement. The query function also forwards its abort signal.
        { cancelRefetch: false, throwOnError: wasFetching },
      );
      if (wasFetching && !clientRefreshQueuedAfterFetchRef.current) {
        clientRefreshQueuedAfterFetchRef.current = true;
        const refreshAfterSuccess = () => {
          if (generation !== clientRefreshGenerationRef.current) {
            return;
          }
          clientRefreshQueuedAfterFetchRef.current = false;
          if (clientRefreshTimerRef.current) {
            clearTimeout(clientRefreshTimerRef.current);
            clientRefreshTimerRef.current = null;
          }
          refresh();
        };
        const scheduleRefreshAfterFailure = () => {
          if (generation !== clientRefreshGenerationRef.current) {
            return;
          }
          clientRefreshQueuedAfterFetchRef.current = false;
          if (!clientRefreshTimerRef.current) {
            clientRefreshTimerRef.current = setTimeout(
              refresh,
              CLIENT_FLAG_REFRESH_MIN_INTERVAL_MS,
            );
          }
        };
        void invalidation.then(
          refreshAfterSuccess,
          scheduleRefreshAfterFailure,
        );
      }
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
    invalidateClientFlags();
    if (cause === "fresh") {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: assistantFeatureFlagsGetQueryKey({
        path: { assistant_id: assistantId },
      }),
    });
  });
}
