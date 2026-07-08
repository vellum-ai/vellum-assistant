import type { QueryClient } from "@tanstack/react-query";

import {
    pluginsByNameGetQueryKey,
    pluginsByNameInspectGetQueryKey,
    pluginsGetQueryKey,
    pluginsSearchGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";

/**
 * Invalidate the plugin queries an install / remove / upgrade / toggle can
 * stale. The installed list and catalog search always go stale. For the
 * per-plugin detail read and its drift inspect: a specific `name` invalidates
 * just that plugin's; omitting `name` (a broad, name-agnostic `plugins:list`
 * sync or a reconnect reconcile) invalidates every open plugin detail for the
 * assistant, since any of them may have changed on another client.
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
    return;
  }
  // No name: invalidate every by-name detail + drift inspect for this assistant
  // via partial-key match (the generated keys are `[{ _id, baseUrl, path }]`;
  // omitting `name`/`baseUrl` matches all names — mirrors the schedules sync).
  void queryClient.invalidateQueries({
    queryKey: [{ _id: "pluginsByNameGet", path: { assistant_id: assistantId } }],
  });
  void queryClient.invalidateQueries({
    queryKey: [
      { _id: "pluginsByNameInspectGet", path: { assistant_id: assistantId } },
    ],
  });
}
