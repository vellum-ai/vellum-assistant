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

/** The whole workspace changes rarely and mutations invalidate it anyway. */
const WORKSPACE_LISTING_STALE_MS = 60_000;

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
  /** The recursive listing stopped at its bound, so deeper entries are missing. */
  isWorkspaceTruncated: boolean;
}

/**
 * Directory listings for the workspace tree.
 *
 * The whole workspace is fetched once as a recursive listing, so search
 * covers every folder and opening one costs nothing. Per-folder listings
 * are fetched only where that leaves a gap: the root while the recursive
 * listing is loading or unsupported, an open folder the recursive walk did
 * not enter (a dependency tree, a truncated subtree), and every open
 * folder in size mode, where the assistant computes directory sizes.
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
  const workspace = useQuery({
    ...workspaceTreeQueryOptions({ assistantId, showHidden, recursive: true }),
    staleTime: WORKSPACE_LISTING_STALE_MS,
  });
  // An assistant without the parameter answers with one level and no
  // `truncated`; that answer is not a workspace listing.
  const workspaceData =
    workspace.data?.truncated === undefined ? undefined : workspace.data;

  const workspaceListings = useMemo(
    () =>
      workspaceData
        ? groupEntriesByDirectory(workspaceData.entries)
        : undefined,
    [workspaceData],
  );

  const paths = useMemo(() => {
    const open = listedDirectoryPaths(expandedPaths, showHidden);
    if (!workspaceListings || sortMode === "size") {
      return open;
    }
    return open.filter((path) => !workspaceListings.has(path));
  }, [expandedPaths, showHidden, workspaceListings, sortMode]);

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
      const root = results[paths.indexOf("")];
      return { listings, isRootLoading: root?.isLoading ?? false };
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
    if (!workspaceListings) {
      return {
        listings: perFolder.listings,
        isRootLoading: perFolder.isRootLoading,
        searchScope: "open-folders",
        isWorkspaceTruncated: false,
      };
    }
    // Per-folder listings win: in size mode they carry the assistant's
    // directory sizes, and elsewhere they only exist for folders the
    // recursive walk did not enter.
    const listings = new Map(workspaceListings);
    for (const [path, entries] of perFolder.listings) {
      listings.set(path, entries);
    }
    return {
      listings,
      isRootLoading: false,
      searchScope: "workspace",
      isWorkspaceTruncated: workspaceData?.truncated === true,
    };
  }, [workspaceListings, workspaceData, perFolder]);
}
