import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
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
  const assistantId = useActiveAssistantId();
  const registry = useMemoizedRegistry(queryClient, assistantId);

  useBusSubscription("sse.event", (envelope) => {
    if (!registry) return;
    const event = envelope.message;
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
  assistantId: string,
): SyncTagRegistry {
  const registry = useMemo(() => {
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
