import type { QueryFunctionContext } from "@tanstack/react-query";

import { pluginsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { pluginsGet } from "@/generated/daemon/sdk.gen";
import type { PluginsGetResponse } from "@/generated/daemon/types.gen";

// The installed list (local filesystem) changes rarely, so a `staleTime`
// keeps it warm across remounts and tab switches.
const INSTALLED_STALE_TIME_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Shared React Query options for the installed-plugins read (`pluginsGet`).
 *
 * The new-chat composer (`useNewChatPlugins`) and the Plugins tab
 * (`usePluginsList`) both build the SAME `pluginsGetQueryKey`, so they resolve
 * to one cache entry. Centralizing the queryKey/queryFn/staleTime here keeps
 * that single entry consistent and stops the two read paths from drifting —
 * notably the older-daemon 404 → empty degradation and the
 * `!response.ok` throw.
 *
 * Depends only on the generated SDK, so it lives in `lib/` (no domain import).
 */
export function installedPluginsQueryOptions(assistantId: string) {
  return {
    queryKey: pluginsGetQueryKey({
      path: { assistant_id: assistantId },
      query: { q: undefined },
    }),
    queryFn: async ({ signal }: QueryFunctionContext) => {
      const result = await pluginsGet({
        path: { assistant_id: assistantId },
        query: { q: undefined },
        signal,
        throwOnError: false,
      });
      const status = result.response?.status;
      // Older daemons return 404 when the list endpoint isn't implemented
      // yet — degrade to an empty installed list.
      if (status === 404) return { plugins: [] } as PluginsGetResponse;
      if (!result.response?.ok) throw new Error("Failed to load plugins");
      return result.data ?? ({ plugins: [] } as PluginsGetResponse);
    },
    staleTime: INSTALLED_STALE_TIME_MS,
  };
}
