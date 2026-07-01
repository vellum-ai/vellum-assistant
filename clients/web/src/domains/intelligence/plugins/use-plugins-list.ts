import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
    InstalledPlugin,
    PluginCatalogMatch,
    PluginListItem,
} from "@/domains/intelligence/plugins/types";
import { mergePlugins, sortPlugins } from "@/domains/intelligence/plugins/utils";
import {
  pluginsGetQueryKey,
  pluginsSearchGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { pluginsGet } from "@/generated/daemon/sdk.gen";
import type { PluginsGetResponse } from "@/generated/daemon/types.gen";
import { installedPluginsQueryOptions } from "@/lib/installed-plugins-query";

// The catalog (the daemon's cached, rate-limited GitHub listing) changes
// rarely, so `staleTime` keeps it warm across tab switches and revisiting
// doesn't refetch. The installed read carries its own staleTime via
// `installedPluginsQueryOptions`.
const CATALOG_STALE_TIME_MS = 5 * 60 * 1000; // 5 minutes

// Stable empty references so consumers' `useMemo`s don't recompute while a
// query is still pending (`?? []` would mint a new array each render).
const EMPTY_INSTALLED: InstalledPlugin[] = [];
const EMPTY_MATCHES: PluginCatalogMatch[] = [];

// Uncategorized bucket slug; mirrors the daemon's UNCATEGORIZED.
export const SYSTEM_CATEGORY = "system";

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
  /**
   * True once the installed read returns `categoryCounts` — the daemon
   * understands the Skills category taxonomy. Older daemons omit it; the tab
   * gates the category rail on this (version-skew safeguard).
   */
  categorySupported: boolean;
  /**
   * Unfiltered installed category counts from the server (before the category
   * filter is applied). Undefined on daemons without taxonomy support.
   */
  installedCategoryCounts: Record<string, number> | undefined;
  /** Unfiltered installed plugins — the client-side fallback for rail counts. */
  installedPlugins: InstalledPlugin[];
  /** Unfiltered installed total, the rail's installed baseline. */
  installedTotal: number | undefined;
  /** Full, unfiltered catalog matches (carry `category`) for rail counts. */
  catalogMatches: PluginCatalogMatch[];
  /**
   * Names of ALL installed plugins, unfiltered by category. Catalog rows and
   * rail counts dedup against this so an installed plugin is never surfaced as
   * "Available" (nor double-counted) regardless of its category bucket — even
   * when its catalog category sits in a different bucket or degraded to
   * null/system.
   */
  unfilteredInstalledNames: Set<string>;
}

/** Installed read with the older-daemon 404 → empty degradation. */
async function fetchInstalled(
  assistantId: string,
  category: string | undefined,
  signal: AbortSignal,
): Promise<PluginsGetResponse> {
  const result = await pluginsGet({
    path: { assistant_id: assistantId },
    query: { q: undefined, category },
    signal,
    throwOnError: false,
  });
  const status = result.response?.status;
  // Older daemons return 404 when the list endpoint isn't implemented yet —
  // degrade to an empty installed list.
  if (status === 404) return { plugins: [] } as PluginsGetResponse;
  if (!result.response?.ok) throw new Error("Failed to load plugins");
  return result.data ?? ({ plugins: [] } as PluginsGetResponse);
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
 *
 * When a `category` slug is passed, the installed list is filtered server-side
 * (`?category=`) while the catalog stays full and is filtered client-side, so
 * both sections honor the selected category. A parallel unfiltered installed
 * read backs the rail badges so they stay stable across category changes.
 */
export function usePluginsList(
  assistantId: string,
  category: string | null = null,
): UsePluginsListResult {
  const categoryParam = category ?? undefined;

  const installedQuery = useQuery({
    queryKey: pluginsGetQueryKey({
      path: { assistant_id: assistantId },
      query: { q: undefined, category: categoryParam },
    }),
    queryFn: ({ signal }) => fetchInstalled(assistantId, categoryParam, signal),
    enabled: Boolean(assistantId),
    staleTime: CATALOG_STALE_TIME_MS,
  });

  // Unfiltered installed read so the rail badges reflect totals across every
  // category while one is selected. Disabled until a category is chosen — when
  // none is, the main read above is already unfiltered (same query key).
  // Reuses the shared installed-plugins query options so the new-chat composer
  // (`useNewChatPlugins`) and this rail resolve to the same cache entry.
  const installedCountsQuery = useQuery({
    ...installedPluginsQueryOptions(assistantId),
    enabled: Boolean(assistantId) && category !== null,
  });

  const catalogQuery = useQuery({
    ...pluginsSearchGetOptions({
      path: { assistant_id: assistantId },
      query: { q: undefined },
    }),
    enabled: Boolean(assistantId),
    staleTime: CATALOG_STALE_TIME_MS,
  });

  // Names of every installed plugin, unfiltered by category. While no category
  // is selected the main read is itself unfiltered; once one is, the parallel
  // counts read backs the set, falling back to the (filtered) main read until
  // it resolves so we never crash — we only briefly under-suppress.
  const unfilteredInstalledNames = useMemo(() => {
    const source =
      category !== null
        ? (installedCountsQuery.data?.plugins ?? installedQuery.data?.plugins)
        : installedQuery.data?.plugins;
    return new Set((source ?? EMPTY_INSTALLED).map((p) => p.name));
  }, [
    category,
    installedCountsQuery.data?.plugins,
    installedQuery.data?.plugins,
  ]);

  const items = useMemo(() => {
    const installed = installedQuery.data?.plugins ?? EMPTY_INSTALLED;
    const matches = catalogQuery.data?.matches ?? EMPTY_MATCHES;
    // Installed is filtered server-side; filter the catalog client-side so the
    // "available" section honors the same category. Then drop any match already
    // installed under ANY category (unfiltered) so an installed plugin bucketed
    // elsewhere — or with a null/system category — is never shown as Available.
    const availableMatches = (
      category === null
        ? matches
        : matches.filter((m) => (m.category ?? SYSTEM_CATEGORY) === category)
    ).filter((m) => !unfilteredInstalledNames.has(m.name));
    return sortPlugins(mergePlugins(installed, availableMatches));
  }, [
    installedQuery.data?.plugins,
    catalogQuery.data?.matches,
    category,
    unfilteredInstalledNames,
  ]);

  // The unfiltered installed read backs both the rail counts and category
  // support: the main read while no category is selected (its key is already
  // unfiltered), the parallel counts read once one is. Reading the filtered
  // main read instead would make these go undefined mid-selection while the
  // filtered request is in flight.
  const unfilteredInstalledData =
    category !== null ? installedCountsQuery.data : installedQuery.data;

  // Latch support sticky once the unfiltered read first carries `categoryCounts`
  // (it's a stable daemon capability): the live OR covers the current render, and
  // the latch keeps it true across a category switch while the unfiltered source
  // is momentarily pending, so the rail never vanishes mid-filter.
  const categoryCountsObserved =
    unfilteredInstalledData?.categoryCounts !== undefined;
  const [categorySupportedLatched, setCategorySupportedLatched] =
    useState(false);
  // Support is a per-assistant daemon capability. Reset the latch when the
  // active assistant changes so a `true` observed for a prior assistant can't
  // keep the rail alive for a next assistant whose daemon omits `categoryCounts`.
  useEffect(() => {
    setCategorySupportedLatched(false);
  }, [assistantId]);
  useEffect(() => {
    if (categoryCountsObserved) setCategorySupportedLatched(true);
  }, [categoryCountsObserved]);
  const categorySupported = categorySupportedLatched || categoryCountsObserved;

  // Self-heal timeout-degraded category counts. A cold catalog can make the
  // daemon's bounded category lookup time out, so the installed read buckets
  // every plugin under `system` and the client caches those counts as fresh. The
  // catalog warms moments later (the daemon caches it), so a later server-side
  // `?category=` request returns the real categories — leaving a stale `system`
  // badge that no longer matches what the filter returns. The catalog query
  // succeeding proves the daemon's catalog is warm: if it disagrees with the
  // cached installed buckets (a plugin the catalog knows is non-`system` that the
  // installed read bucketed `system`), refetch the unfiltered installed read once
  // so the badges match the warmed server. One-shot per assistant — the refetch
  // reads the warm catalog and clears the disagreement, so it can't loop.
  const queryClient = useQueryClient();
  const healedAssistant = useRef<string | null>(null);
  useEffect(() => {
    if (healedAssistant.current === assistantId) return;
    if (!catalogQuery.isSuccess) return;
    const installed = unfilteredInstalledData?.plugins;
    if (!installed?.length) return;
    const realCategory = new Map(
      (catalogQuery.data?.matches ?? EMPTY_MATCHES).map((m) => [
        m.name,
        m.category,
      ]),
    );
    const stale = installed.some((p) => {
      const real = realCategory.get(p.name);
      return (
        real != null &&
        real !== SYSTEM_CATEGORY &&
        (p.category ?? SYSTEM_CATEGORY) === SYSTEM_CATEGORY
      );
    });
    if (!stale) return;
    healedAssistant.current = assistantId;
    void queryClient.invalidateQueries({
      queryKey: pluginsGetQueryKey({
        path: { assistant_id: assistantId },
        query: { q: undefined },
      }),
    });
  }, [
    assistantId,
    catalogQuery.isSuccess,
    catalogQuery.data?.matches,
    unfilteredInstalledData?.plugins,
    queryClient,
  ]);

  return {
    items,
    // Installed-only: a slow/retrying catalog must not hide installed plugins.
    isLoading: installedQuery.isLoading,
    catalogLoading: catalogQuery.isLoading,
    // Only the installed failure is fatal; a catalog failure degrades.
    isError: installedQuery.isError,
    isFetching: installedQuery.isFetching || catalogQuery.isFetching,
    catalogError: catalogQuery.isError,
    categorySupported,
    installedCategoryCounts: unfilteredInstalledData?.categoryCounts,
    installedPlugins: unfilteredInstalledData?.plugins ?? EMPTY_INSTALLED,
    installedTotal: unfilteredInstalledData?.totalCount,
    catalogMatches: catalogQuery.data?.matches ?? EMPTY_MATCHES,
    unfilteredInstalledNames,
  };
}
