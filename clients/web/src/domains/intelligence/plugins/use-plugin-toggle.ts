import { useMutation, useQueryClient } from "@tanstack/react-query";

import { PLUGIN_TOGGLE_ERROR } from "@/domains/intelligence/plugins/constants";
import { invalidatePluginQueries } from "@/domains/intelligence/plugins/invalidate-plugin-queries";
import { pluginsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import {
    pluginsByNameDisablePost,
    pluginsByNameEnablePost,
} from "@/generated/daemon/sdk.gen";
import type { PluginsGetResponse } from "@/generated/daemon/types.gen";
import { toast } from "@vellumai/design-library";

interface TogglePluginVariables {
  name: string;
  nextEnabled: boolean;
}

export interface UsePluginToggleResult {
  /** Enable (`nextEnabled=true`) or disable a plugin, optimistically. */
  toggle: (name: string, nextEnabled: boolean) => void;
  /** Name of the plugin whose toggle is in flight, or `null` when idle. */
  togglingName: string | null;
}

/**
 * Optimistic enable/disable mutation for the Plugins tab. Flips the installed
 * row's `enabled` in every cached `pluginsGet` variant immediately (the
 * unfiltered list plus every `?category=` filtered read `usePluginsList`
 * mounts), rolls back only that row's field and toasts on failure, and
 * invalidates the plugin queries on settle so the cache re-syncs with the
 * daemon (which also broadcasts `sync_changed`). Mirrors the optimistic
 * pattern in `settings/pages/sounds-page.tsx`.
 *
 * No confirm dialog — the action is reversible.
 */
export function usePluginToggle(assistantId: string): UsePluginToggleResult {
  const queryClient = useQueryClient();

  // Partial key matching every `pluginsGet` cache for this assistant — the
  // unfiltered list AND each server-side `?category=` filtered read. Omitting
  // `query` makes TanStack partial-match all variants (same idiom as
  // `invalidatePluginQueries`); patching only the unfiltered key would leave a
  // category-filtered view stale until the settle refetch.
  const listQueryFilter = {
    queryKey: pluginsGetQueryKey({ path: { assistant_id: assistantId } }),
  };

  // Set `name`'s `enabled` across every matching cache variant, leaving other
  // rows (and other caches) untouched.
  const setRowEnabled = (name: string, enabled: boolean) => {
    queryClient.setQueriesData<PluginsGetResponse>(listQueryFilter, (prev) =>
      prev
        ? {
            ...prev,
            plugins: prev.plugins.map((plugin) =>
              plugin.name === name ? { ...plugin, enabled } : plugin,
            ),
          }
        : prev,
    );
  };

  const mutation = useMutation({
    mutationFn: async ({ name, nextEnabled }: TogglePluginVariables) => {
      const result = await (nextEnabled
        ? pluginsByNameEnablePost({
            path: { assistant_id: assistantId, name },
            throwOnError: false,
          })
        : pluginsByNameDisablePost({
            path: { assistant_id: assistantId, name },
            throwOnError: false,
          }));
      // 409 means the plugin is already in the desired state — a no-op from a
      // stale cache or a second client. The end state holds, so treat it as
      // success and let `onSettled` refetch the truth; only other non-ok
      // statuses are real failures.
      const status = result.response?.status;
      if (result.response?.ok || status === 409) return result;
      throw new Error(`Plugin toggle failed (${status ?? "network error"})`);
    },
    onMutate: async ({ name, nextEnabled }) => {
      await queryClient.cancelQueries(listQueryFilter);
      setRowEnabled(name, nextEnabled);
    },
    onError: (_error, { name, nextEnabled }) => {
      // Roll back only this row's `enabled` — a full-snapshot restore would
      // clobber a concurrent toggle's newer value on a different row.
      setRowEnabled(name, !nextEnabled);
      toast.error(PLUGIN_TOGGLE_ERROR);
    },
    onSettled: (_data, _error, variables) => {
      invalidatePluginQueries(queryClient, assistantId, variables.name);
    },
  });

  const toggle = (name: string, nextEnabled: boolean) => {
    mutation.mutate({ name, nextEnabled });
  };

  return {
    toggle,
    togglingName: mutation.isPending ? (mutation.variables?.name ?? null) : null,
  };
}
