import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { createSyncTagRegistry } from "@/lib/sync/tag-registry";
import {
  invalidateAssistantConfigQueries,
  invalidateAssistantSchedulesQueries,
  invalidateAssistantSoundsQueries,
} from "@/lib/sync/query-tags";
import { SYNC_TAGS } from "@/lib/sync/types";

/**
 * Routes settings-related sync events into TanStack Query caches while
 * the settings pages are mounted. Subscribes to the layout-scoped event
 * bus for both the SSE stream (`sse.event` for `sync_changed` tags,
 * `sse.opened` to dispatch a reconcile on reconnect) and the app
 * lifecycle (`app.resume` for a manual reconcile on tab focus / app
 * foreground / network online).
 */
export function useSettingsSync(): void {
  const queryClient = useQueryClient();
  const { data: assistantList } = useQuery(assistantsListOptions());
  const assistantId = assistantList?.results?.[0]?.id ?? null;

  // The sync-tag registry is rebuilt whenever the active assistant
  // changes so dispatches always carry the current assistant id. A
  // ref-stored registry would re-target stale callbacks after an
  // assistant switch.
  const registry = useMemoizedRegistry(queryClient, assistantId);

  useBusSubscription("sse.event", (event) => {
    if (!registry) return;
    if (event.type === "sync_changed") {
      void registry.dispatch(event);
    }
  });

  useBusSubscription("sse.opened", ({ cause }) => {
    if (!registry) return;
    if (cause === "fresh") return;
    void registry.dispatchReconnect();
  });

  useBusSubscription("app.resume", () => {
    if (!registry) return;
    void registry.dispatchReconnect();
  });
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

import { useMemo } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { SyncTagRegistry } from "@/lib/sync/tag-registry";

function useMemoizedRegistry(
  queryClient: QueryClient,
  assistantId: string | null,
): SyncTagRegistry | null {
  const registry = useMemo(() => {
    if (!assistantId) return null;
    const r = createSyncTagRegistry();
    r.register(SYNC_TAGS.assistantConfig, () => {
      invalidateAssistantConfigQueries(queryClient, assistantId);
    });
    r.register(SYNC_TAGS.assistantSounds, () => {
      invalidateAssistantSoundsQueries(queryClient, assistantId);
    });
    r.register(SYNC_TAGS.assistantSchedules, () => {
      invalidateAssistantSchedulesQueries(queryClient, assistantId);
    });
    return r;
  }, [queryClient, assistantId]);

  // Clear the previous registry when the assistant or queryClient
  // changes; without this the orphaned registry would retain stale
  // closures over the old assistant id.
  useEffect(() => {
    if (!registry) return;
    return () => registry.clear();
  }, [registry]);

  return registry;
}
