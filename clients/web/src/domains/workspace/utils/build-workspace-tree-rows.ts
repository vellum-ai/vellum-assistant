/**
 * Pure derivations behind the workspace file tree: which directory listings
 * the tree needs, the per-directory grouping of a recursive listing, and the
 * flat list of rows it renders from those listings.
 *
 * Search reads loaded listings only, so a query costs no requests. How far it
 * reaches is how far the listings do: the whole workspace when the assistant
 * answered a recursive listing, open folders otherwise.
 */

import type { WorkspaceTreeGetResponse } from "@/generated/daemon/types.gen";
import { workspaceDirOf } from "@/utils/workspace-path-links";

import { isHiddenPath } from "./is-hidden-path";
import { sortEntries, type WorkspaceSortMode } from "./sort-entries";

export type WorkspaceTreeEntry = WorkspaceTreeGetResponse["entries"][number];

export interface WorkspaceTreeRow {
  entry: WorkspaceTreeEntry;
  depth: number;
  /** The folder is open. Its children follow it once its listing has loaded. */
  isExpanded: boolean;
}

/** Workspace-relative path of the root listing. */
export const WORKSPACE_ROOT_PATH = "";

/**
 * Directories whose listings the tree shows: the root, plus every open folder
 * whose ancestors are all open. An open folder under a closed one stays in
 * `expandedPaths` so it reopens with its parent, but is not listed until then.
 * With hidden entries off, an open hidden folder is not listed either: the
 * assistant refuses the request, and the folder reopens when they are shown.
 */
export function listedDirectoryPaths(
  expandedPaths: Set<string>,
  showHidden: boolean,
): string[] {
  const paths = [WORKSPACE_ROOT_PATH];
  for (const path of expandedPaths) {
    if (!showHidden && isHiddenPath(path)) {
      continue;
    }
    const segments = path.split("/");
    let visible = true;
    for (let i = 1; i < segments.length; i++) {
      if (!expandedPaths.has(segments.slice(0, i).join("/"))) {
        visible = false;
        break;
      }
    }
    if (visible) {
      paths.push(path);
    }
  }
  return paths;
}

/**
 * A recursive listing's entries grouped by the directory that holds them, in
 * the order they arrived. The assistant lists depth-first with each
 * directory's entries in listing order and never part of a directory, so
 * every group is that directory's whole listing. A directory with no group
 * was listed but not entered (a dependency tree, an empty folder, or one
 * past the walk's bound) and is fetched on its own when opened.
 */
export function groupEntriesByDirectory(
  entries: readonly WorkspaceTreeEntry[],
): Map<string, WorkspaceTreeEntry[]> {
  const groups = new Map<string, WorkspaceTreeEntry[]>();
  for (const entry of entries) {
    const directory = workspaceDirOf(entry.path);
    const group = groups.get(directory);
    if (group) {
      group.push(entry);
    } else {
      groups.set(directory, [entry]);
    }
  }
  return groups;
}

/**
 * Flatten loaded listings into the rows the tree renders, depth-first in
 * listing order.
 *
 * With a query, every folder with a loaded listing is looked inside. A file
 * row appears when its name contains the query; a folder row appears when
 * its own name does or when a row inside it appears, and it shows as open so
 * those rows are visible.
 */
export function buildWorkspaceTreeRows({
  listings,
  expandedPaths,
  sortMode,
  query,
}: {
  listings: ReadonlyMap<string, WorkspaceTreeEntry[]>;
  expandedPaths: Set<string>;
  sortMode: WorkspaceSortMode;
  query: string;
}): WorkspaceTreeRow[] {
  const needle = query.trim().toLowerCase();

  function rowsFor(directoryPath: string, depth: number): WorkspaceTreeRow[] {
    const entries = listings.get(directoryPath);
    if (!entries) {
      return [];
    }
    const rows: WorkspaceTreeRow[] = [];
    for (const entry of sortEntries(entries, sortMode)) {
      const isDirectory = entry.type === "directory";
      const isOpen = isDirectory && expandedPaths.has(entry.path);
      const children =
        isOpen || (isDirectory && needle !== "")
          ? rowsFor(entry.path, depth + 1)
          : [];
      const nameMatches =
        needle === "" || entry.name.toLowerCase().includes(needle);
      if (nameMatches || children.length > 0) {
        rows.push(
          { entry, depth, isExpanded: isOpen || children.length > 0 },
          ...children,
        );
      }
    }
    return rows;
  }

  return rowsFor(WORKSPACE_ROOT_PATH, 0);
}
