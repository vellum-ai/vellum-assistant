/**
 * Pure derivations behind the workspace file tree: which directory listings
 * the tree needs, and the flat list of rows it renders from those listings.
 *
 * The tree never fetches a directory the user has not opened. Search filters
 * the rows these listings already produce, so a query costs no requests and a
 * file inside a closed folder is not a result.
 */

import type { WorkspaceTreeGetResponse } from "@/generated/daemon/types.gen";

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
 */
export function listedDirectoryPaths(expandedPaths: Set<string>): string[] {
  const paths = [WORKSPACE_ROOT_PATH];
  for (const path of expandedPaths) {
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
 * Flatten loaded listings into the rows the tree renders, depth-first in
 * listing order.
 *
 * With a query, a file row appears when its name contains the query, and a
 * folder row appears when its own name does or when a row inside it appears.
 * Only open folders with loaded listings are looked inside.
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
      const isExpanded = isDirectory && expandedPaths.has(entry.path);
      const children = isExpanded ? rowsFor(entry.path, depth + 1) : [];
      const nameMatches =
        needle === "" || entry.name.toLowerCase().includes(needle);
      if (nameMatches || children.length > 0) {
        rows.push({ entry, depth, isExpanded }, ...children);
      }
    }
    return rows;
  }

  return rowsFor(WORKSPACE_ROOT_PATH, 0);
}
