import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { PluginListItem } from "@/domains/intelligence/plugins/types";
import { mergePlugins, sortPlugins } from "@/domains/intelligence/plugins/utils";
import { pluginsSearchGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { installedPluginsQueryOptions } from "@/lib/installed-plugins-query";

// The catalog (the daemon's cached, rate-limited GitHub listing) changes
// rarely, so `staleTime` keeps it warm across tab switches and revisiting
// doesn't refetch. The installed read carries its own staleTime via
// `installedPluginsQueryOptions`.
const CATALOG_STALE_TIME_MS = 5 * 60 * 1000; // 5 minutes

export interface UsePluginsListResult {
  /** Installed + catalog merged into one deduped, sorted list. */
  items: PluginListItem[];
  /**
   * True until the installed list first resolves. The catalog loads in the
   * background and must not block the installed plugins from rendering.
   */
  isLoading: boolean;
  /** True until the catalog (available-to-install) first resolves. */
  catalogLoading: boolean;
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
    ...installedPluginsQueryOptions(assistantId),
    enabled: Boolean(assistantId),
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
    // Installed-only: a slow/retrying catalog must not hide installed plugins.
    isLoading: installedQuery.isLoading,
    catalogLoading: catalogQuery.isLoading,
    // Only the installed failure is fatal; a catalog failure degrades.
    isError: installedQuery.isError,
    isFetching: installedQuery.isFetching || catalogQuery.isFetching,
    catalogError: catalogQuery.isError,
  };
}
