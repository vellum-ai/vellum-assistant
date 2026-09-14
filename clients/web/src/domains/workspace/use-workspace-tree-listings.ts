import {
  useQueries,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import type { WorkspaceTreeGetResponse } from "@/generated/daemon/types.gen";
import { workspaceTreeQueryOptions } from "@/lib/workspace-tree-query";

import type { WorkspaceSortMode } from "./utils/sort-entries";
import {
  groupEntriesByDirectory,
  listedDirectoryPaths,
  type WorkspaceTreeEntry,
} from "./utils/build-workspace-tree-rows";

export interface WorkspaceTreeListings {
  /** Loaded directory contents keyed by workspace-relative path. */
  listings: ReadonlyMap<string, WorkspaceTreeEntry[]>;
  /** The root listing has not arrived yet. */
  isRootLoading: boolean;
  /**
   * How far a search reaches. `workspace` once the assistant has answered a
   * recursive listing, `open-folders` while it has not or cannot: assistants
   * that predate the parameter answer with one level.
   */
  searchScope: "workspace" | "open-folders";
  /**
   * A workspace search does not cover every folder: the listing stopped at
   * its bound, or a folder the walk did not enter (a dependency tree, a
   * symlink, an unreadable directory) is closed. Opening such a folder
   * lists it on its own and brings it into the search.
   */
  isSearchIncomplete: boolean;
}

/**
 * Directory listings for the workspace tree.
 *
 * The whole workspace is fetched as one recursive listing, so search reaches
 * every folder and a folder's contents show the moment it opens. Every open
 * folder is also listed on its own, as it always was: that request refreshes
 * what the recursive listing showed and, for a folder the walk did not
 * enter, is the only way to see inside. Per-folder listings win where both
 * exist; in size mode they also carry the directory sizes the assistant
 * computes.
 *
 * Both reads keep the app's default freshness. Nothing pushes an
 * invalidation when the assistant writes a file, so a focus or remount
 * refetch is what picks those up, exactly as before.
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
  const { data: workspaceData } = useQuery(
    workspaceTreeQueryOptions({ assistantId, showHidden, recursive: true }),
  );
  // An assistant without the parameter answers with one level and no
  // `truncated`; that answer is not a workspace listing.
  const workspace = useMemo(
    () =>
      workspaceData?.truncated === undefined
        ? undefined
        : {
            listings: groupEntriesByDirectory(workspaceData.entries),
            truncated: workspaceData.truncated,
            skipped: workspaceData.skipped ?? [],
          },
    [workspaceData],
  );

  const paths = useMemo(
    () => listedDirectoryPaths(expandedPaths, showHidden),
    [expandedPaths, showHidden],
  );

  const combine = useCallback(
    (
      results: UseQueryResult<WorkspaceTreeGetResponse>[],
    ): {
      listings: Map<string, WorkspaceTreeEntry[]>;
      isRootLoading: boolean;
    } => {
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

  const perFolder = useQueries({
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

  return useMemo(() => {
    if (!workspace) {
      return {
        listings: perFolder.listings,
        isRootLoading: perFolder.isRootLoading,
        searchScope: "open-folders",
        isSearchIncomplete: false,
      };
    }
    const listings = new Map(workspace.listings);
    for (const [path, entries] of perFolder.listings) {
      listings.set(path, entries);
    }
    return {
      listings,
      isRootLoading: false,
      searchScope: "workspace",
      isSearchIncomplete:
        workspace.truncated || workspace.skipped.some((p) => !listings.has(p)),
    };
  }, [workspace, perFolder]);
}
