import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import type { WorkspaceTreeGetResponse } from "@/generated/daemon/types.gen";
import { workspaceTreeQueryOptions } from "@/lib/workspace-tree-query";

import type { WorkspaceSortMode } from "./utils/sort-entries";
import {
  listedDirectoryPaths,
  type WorkspaceTreeEntry,
} from "./utils/build-workspace-tree-rows";

export interface WorkspaceTreeListings {
  /** Loaded directory contents keyed by workspace-relative path. */
  listings: ReadonlyMap<string, WorkspaceTreeEntry[]>;
  /** The root listing has not arrived yet. */
  isRootLoading: boolean;
}

/**
 * Directory listings for the workspace tree: the root and every open folder,
 * fetched in parallel through the shared tree query factory.
 *
 * Opening a folder is the only thing that adds a request. Search, sorting,
 * and row rendering read what is already loaded.
 */
export function useWorkspaceTreeListings({
  assistantId,
  expandedPaths,
  showHidden,
  sortMode,
}: {
  assistantId: string;
  expandedPaths: Set<string>;
  showHidden: boolean;
  sortMode: WorkspaceSortMode;
}): WorkspaceTreeListings {
  const paths = useMemo(
    () => listedDirectoryPaths(expandedPaths),
    [expandedPaths],
  );

  const combine = useCallback(
    (
      results: UseQueryResult<WorkspaceTreeGetResponse>[],
    ): WorkspaceTreeListings => {
      const listings = new Map<string, WorkspaceTreeEntry[]>();
      results.forEach((result, index) => {
        if (result.data) {
          listings.set(paths[index], result.data.entries);
        }
      });
      return { listings, isRootLoading: results[0]?.isLoading ?? true };
    },
    [paths],
  );

  return useQueries({
    queries: paths.map((path) =>
      workspaceTreeQueryOptions({
        assistantId,
        path,
        showHidden,
        includeDirSizes: sortMode === "size",
      }),
    ),
    combine,
  });
}
