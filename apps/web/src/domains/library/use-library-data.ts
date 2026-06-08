/**
 * Encapsulates data fetching and search/filter logic for the library view.
 *
 * Queries apps and documents via TanStack Query, manages search state,
 * and derives filtered/pinned/recent partitions from the raw data.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  appsGetOptions,
  documentsGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";

/**
 * Order apps most-recently-touched first. Sorting by `updatedAt` (not
 * `createdAt`) keeps a freshly edited app at the top and matches the daemon's
 * own ordering, so updated apps resurface in the Library instead of staying
 * buried by creation order. `createdAt` breaks ties.
 */
const byMostRecentlyUpdated = (
  a: { updatedAt: number; createdAt: number },
  b: { updatedAt: number; createdAt: number },
) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;

export function useLibraryData(assistantId: string) {
  const pinnedAppIds = usePinnedAppsStore.use.pinnedAppIds();

  const { data: apps = [], isLoading: appsLoading, error: appsError } = useQuery({
    ...appsGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.apps,
  });

  const { data: documents = [], isLoading: docsLoading, error: docsError } = useQuery({
    ...documentsGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.documents,
  });

  const loading = appsLoading || docsLoading;
  const error = appsError && docsError
    ? (appsError instanceof Error ? appsError.message : "Failed to load library")
    : null;

  const [searchText, setSearchText] = useState("");

  const filteredApps = useMemo(() => {
    if (!searchText.trim()) return apps;
    const lower = searchText.toLowerCase();
    return apps.filter(
      (a) =>
        a.name.toLowerCase().includes(lower) ||
        a.description?.toLowerCase().includes(lower),
    );
  }, [apps, searchText]);

  const pinnedApps = useMemo(
    () => filteredApps.filter((a) => pinnedAppIds.has(a.id)).sort(byMostRecentlyUpdated),
    [filteredApps, pinnedAppIds],
  );

  const recentApps = useMemo(
    () => filteredApps.filter((a) => !pinnedAppIds.has(a.id)).sort(byMostRecentlyUpdated),
    [filteredApps, pinnedAppIds],
  );

  const filteredDocuments = useMemo(() => {
    if (!searchText.trim()) return documents;
    const lower = searchText.toLowerCase();
    return documents.filter((d) => d.title.toLowerCase().includes(lower));
  }, [documents, searchText]);

  return {
    apps,
    documents,
    filteredApps,
    pinnedApps,
    recentApps,
    filteredDocuments,
    searchText,
    setSearchText,
    loading,
    error,
  };
}
