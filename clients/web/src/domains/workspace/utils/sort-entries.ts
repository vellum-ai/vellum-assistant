/**
 * Client-side sort helper for workspace tree entries.
 *
 * The tree endpoint always returns `directories first, then alphabetical`,
 * which is the right ordering for "sort by name" mode. The "sort by size"
 * mode interleaves files and folders by recursive byte size; this helper
 * implements that re-ordering without requiring a second round-trip.
 */

export type WorkspaceSortMode = "name" | "size";

export interface SortableWorkspaceEntry {
  name?: string;
  type?: string;
  size?: number | null;
}

/**
 * Re-sort tree entries on the client to match the active sort mode.
 *
 * - `name` mode is a passthrough — the server has already ordered entries.
 * - `size` mode sorts everything by size descending in one pool (files and
 *   dirs mixed) so the heaviest entries float to the top regardless of type.
 *   Entries whose size couldn't be computed (`size: null`, typically because
 *   the recursive budget was exhausted on the server) sink to the bottom and
 *   tiebreak by name.
 */
export function sortEntries<T extends SortableWorkspaceEntry>(
  entries: T[],
  mode: WorkspaceSortMode,
): T[] {
  if (mode === "name") return entries;
  const copy = entries.slice();
  copy.sort((a, b) => {
    const aSize = a.size ?? null;
    const bSize = b.size ?? null;
    if (aSize === null && bSize === null) {
      return (a.name ?? "").localeCompare(b.name ?? "");
    }
    if (aSize === null) return 1;
    if (bSize === null) return -1;
    if (aSize !== bSize) return bSize - aSize;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
  return copy;
}
