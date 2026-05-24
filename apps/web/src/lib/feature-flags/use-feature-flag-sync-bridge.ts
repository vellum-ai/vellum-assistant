/**
 * Bridge from the assistant SSE event bus to React Query invalidations
 * for the feature flag endpoints.
 *
 * Mounted on `RootLayout` so flag changes propagate on every
 * authenticated route — not just chat — since flag consumers live in
 * the chat-layout header, billing, settings, theme, plugins, etc.
 *
 * The daemon emits a `sync_changed` event with one or both of
 * `feature-flags:client` / `feature-flags:assistant` whenever the
 * gateway detects local override or remote platform flag changes
 * (see `assistant/src/ipc/gateway-flag-listener.ts`). This hook
 * translates those tags into TanStack Query invalidations for the
 * cached `useAssistantFeatureFlagSync` /
 * `useClientFeatureFlagSync` queries — the existing root-level sync
 * hooks then refetch and write the fresh values back into their
 * zustand stores.
 *
 * The bridge replaces what used to be a 5s `refetchInterval` on both
 * sync hooks. Push beats poll.
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { AssistantEvent } from "@/domains/chat/api/event-types.js";
import { ASSISTANT_FLAG_VALUES_QUERY_KEY } from "@/lib/feature-flags/use-assistant-feature-flag-sync.js";
import { CLIENT_FLAG_QUERY_KEY } from "@/lib/feature-flags/use-client-feature-flag-sync.js";
import { SYNC_TAGS, type SyncChangedEvent } from "@/lib/sync/types.js";
import { useEventBusStore } from "@/stores/event-bus-store.js";

export function useFeatureFlagSyncBridge(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const handleSyncChanged = (event: SyncChangedEvent) => {
      for (const tag of event.tags) {
        if (tag === SYNC_TAGS.featureFlagsClient) {
          void queryClient.invalidateQueries({
            queryKey: CLIENT_FLAG_QUERY_KEY,
          });
        } else if (tag === SYNC_TAGS.featureFlagsAssistant) {
          // Prefix invalidation: TanStack matches every cached
          // `[ASSISTANT_FLAG_VALUES_QUERY_KEY, <assistantId>]`. We
          // don't narrow by assistant — the daemon emits a single
          // global event for any flag change and the active-assistant
          // query is the only one that ever has a non-stale
          // subscriber anyway.
          void queryClient.invalidateQueries({
            queryKey: [ASSISTANT_FLAG_VALUES_QUERY_KEY],
          });
        }
      }
    };

    const handleEvent = (event: AssistantEvent) => {
      if (event.type === "sync_changed") {
        handleSyncChanged(event);
      }
    };

    const unsubscribe = useEventBusStore
      .getState()
      .subscribe("sse.event", handleEvent);

    return unsubscribe;
  }, [queryClient]);
}
