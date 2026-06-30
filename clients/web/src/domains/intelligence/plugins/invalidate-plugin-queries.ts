import type { QueryClient } from "@tanstack/react-query";

import {
    pluginsByNameGetQueryKey,
    pluginsByNameInspectGetQueryKey,
    pluginsGetQueryKey,
    pluginsSearchGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

/**
 * Invalidate the plugin queries an install / remove / upgrade can stale. The
 * installed list and catalog search always go stale; the per-plugin detail
 * read and its drift inspect only when a specific plugin `name` is supplied.
 */
export function invalidatePluginQueries(
  queryClient: QueryClient,
  assistantId: string,
  name?: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: pluginsGetQueryKey({ path: { assistant_id: assistantId } }),
  });
  void queryClient.invalidateQueries({
    queryKey: pluginsSearchGetQueryKey({
      path: { assistant_id: assistantId },
    }),
  });
  if (name) {
    void queryClient.invalidateQueries({
      queryKey: pluginsByNameGetQueryKey({
        path: { assistant_id: assistantId, name },
      }),
    });
    void queryClient.invalidateQueries({
      queryKey: pluginsByNameInspectGetQueryKey({
        path: { assistant_id: assistantId, name },
      }),
    });
  }
}
