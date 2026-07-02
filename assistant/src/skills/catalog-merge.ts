/**
 * Pure catalog-merge helpers.
 *
 * Kept separate from `catalog-install.ts` (which owns network/filesystem
 * I/O and is therefore mocked wholesale by many tests) so that consumers can
 * merge catalogs without pulling the I/O module — and so mocking the I/O
 * module never nulls out these pure functions.
 */

/** Minimal shape needed to order catalog entries by freshness. */
interface DatedCatalogEntry {
  id: string;
  updatedAt?: string;
}

/** `updatedAt` as epoch millis, or -Infinity when missing/unparseable. */
export function catalogEntryTime(
  entry: Pick<DatedCatalogEntry, "updatedAt">,
): number {
  const time = entry.updatedAt ? Date.parse(entry.updatedAt) : NaN;
  return Number.isFinite(time) ? time : -Infinity;
}

/**
 * Merge a local (bundled/dev) catalog with a remote platform catalog.
 *
 * For ids present in both, the entry with the newer `updatedAt` wins — a
 * bundled catalog from an older build must not shadow a platform entry that
 * was published after the build (staleness checks compare against this merged
 * view, so a local-always-wins merge would hide every post-release skill
 * update). Ties and missing timestamps keep the local entry. Remote-only
 * skills are appended so skills published after a release are discoverable.
 */
export function mergeCatalogsPreferFresh<T extends DatedCatalogEntry>(
  local: T[],
  remote: T[],
): T[] {
  const remoteById = new Map(remote.map((s) => [s.id, s]));
  const localIds = new Set(local.map((s) => s.id));
  const merged = local.map((localEntry) => {
    const remoteEntry = remoteById.get(localEntry.id);
    if (!remoteEntry) {
      return localEntry;
    }
    return catalogEntryTime(remoteEntry) > catalogEntryTime(localEntry)
      ? remoteEntry
      : localEntry;
  });
  return [...merged, ...remote.filter((s) => !localIds.has(s.id))];
}
