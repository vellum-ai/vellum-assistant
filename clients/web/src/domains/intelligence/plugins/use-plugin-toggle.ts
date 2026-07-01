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
 * row's `enabled` in the cached list immediately, rolls the snapshot back and
 * toasts on failure, and invalidates the plugin queries on settle so the cache
 * re-syncs with the daemon (which also broadcasts `sync_changed`). Mirrors the
 * optimistic pattern in `settings/pages/sounds-page.tsx`.
 *
 * No confirm dialog — the action is reversible.
 */
export function usePluginToggle(assistantId: string): UsePluginToggleResult {
  const queryClient = useQueryClient();

  // The unfiltered installed-list key `usePluginsList` reads for the default
  // (no category) view; also the key `invalidatePluginQueries` staleness-marks.
  const listQueryKey = pluginsGetQueryKey({
    path: { assistant_id: assistantId },
    query: { q: undefined },
  });

  const mutation = useMutation({
    mutationFn: ({ name, nextEnabled }: TogglePluginVariables) =>
      nextEnabled
        ? pluginsByNameEnablePost({
            path: { assistant_id: assistantId, name },
            throwOnError: true,
          })
        : pluginsByNameDisablePost({
            path: { assistant_id: assistantId, name },
            throwOnError: true,
          }),
    onMutate: async ({ name, nextEnabled }) => {
      await queryClient.cancelQueries({ queryKey: listQueryKey });
      const previous =
        queryClient.getQueryData<PluginsGetResponse>(listQueryKey);
      queryClient.setQueryData<PluginsGetResponse>(listQueryKey, (prev) =>
        prev
          ? {
              ...prev,
              plugins: prev.plugins.map((plugin) =>
                plugin.name === name
                  ? { ...plugin, enabled: nextEnabled }
                  : plugin,
              ),
            }
          : prev,
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listQueryKey, context.previous);
      }
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
