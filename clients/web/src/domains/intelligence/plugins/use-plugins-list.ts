import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { PluginListItem } from "@/domains/intelligence/plugins/types";
import { mergePlugins, sortPlugins } from "@/domains/intelligence/plugins/utils";
import {
    pluginsGetQueryKey,
    pluginsSearchGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { pluginsGet } from "@/generated/daemon/sdk.gen";
import type { PluginsGetResponse } from "@/generated/daemon/types.gen";

// The installed list (local filesystem) and the catalog (the daemon's
// cached, rate-limited GitHub listing) both change rarely, so `staleTime`
// keeps each warm across tab switches and revisiting doesn't refetch.
const CATALOG_STALE_TIME_MS = 5 * 60 * 1000; // 5 minutes

export interface UsePluginsListResult {
  /** Installed + catalog merged into one deduped, sorted list. */
  items: PluginListItem[];
  /** True until both underlying queries have first resolved. */
  isLoading: boolean;
  /** Fatal: the installed list failed to load. Catalog failures degrade. */
  isError: boolean;
  /** True while either underlying query is fetching (incl. background). */
  isFetching: boolean;
  /**
   * Non-fatal: the catalog failed to load. The list still renders the
   * installed plugins; the view surfaces this as a degraded "installed only".
   */
  catalogError: boolean;
}

/**
 * Single source of truth for the Plugins tab list: the installed read
 * (`pluginsGet`, with an older-daemon 404 → empty degradation) and the
 * catalog (`pluginsSearchGet`), merged via `mergePlugins` and `sortPlugins`
 * into one `PluginListItem[]`.
 *
 * The installed list is fatal — its failure surfaces as `isError`. The
 * catalog is best-effort: a failure degrades to "installed only" and is
 * exposed via `catalogError` rather than failing the whole list.
 */
export function usePluginsList(assistantId: string): UsePluginsListResult {
  const installedQuery = useQuery({
    queryKey: pluginsGetQueryKey({
      path: { assistant_id: assistantId },
      query: { q: undefined },
    }),
    queryFn: async ({ signal }) => {
      const result = await pluginsGet({
        path: { assistant_id: assistantId },
        query: { q: undefined },
        signal,
        throwOnError: false,
      });
      const status = result.response?.status;
      // Older daemons return 404 when the list endpoint isn't
      // implemented yet — degrade to an empty installed list.
      if (status === 404) return { plugins: [] } as PluginsGetResponse;
      if (!result.response?.ok) throw new Error("Failed to load plugins");
      return result.data ?? ({ plugins: [] } as PluginsGetResponse);
    },
    enabled: Boolean(assistantId),
    staleTime: CATALOG_STALE_TIME_MS,
  });

  const catalogQuery = useQuery({
    ...pluginsSearchGetOptions({
      path: { assistant_id: assistantId },
      query: { q: undefined },
    }),
    enabled: Boolean(assistantId),
    staleTime: CATALOG_STALE_TIME_MS,
  });

  const items = useMemo(
    () =>
      sortPlugins(
        mergePlugins(
          installedQuery.data?.plugins ?? [],
          catalogQuery.data?.matches ?? [],
        ),
      ),
    [installedQuery.data?.plugins, catalogQuery.data?.matches],
  );

  return {
    items,
    isLoading: installedQuery.isLoading || catalogQuery.isLoading,
    // Only the installed failure is fatal; a catalog failure degrades.
    isError: installedQuery.isError,
    isFetching: installedQuery.isFetching || catalogQuery.isFetching,
    catalogError: catalogQuery.isError,
  };
}
