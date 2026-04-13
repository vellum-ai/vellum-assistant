/**
 * Helpers for listing on-disk backup snapshots.
 *
 * A "snapshot" here is any file inside a backup destination directory whose
 * name matches the canonical `backup-YYYYMMDD-HHMMSS.vbundle[.enc]` pattern
 * defined in `./paths.ts`. Anything else (READMEs, dotfiles, partial writes)
 * is silently ignored so callers can scan a destination without worrying
 * about non-snapshot clutter.
 *
 * The list helper is intentionally pure: it takes an explicit directory and
 * touches no global state, which makes both production code and tests cheap
 * to drive against tmp directories.
 */

import { readdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseBackupTimestamp } from "./paths.js";

/**
 * Metadata about a single backup snapshot file. The `path` is the absolute
 * path on disk; `createdAt` is parsed from the filename (UTC) rather than
 * read from filesystem mtime so that copies/restores preserve their original
 * snapshot identity.
 */
export interface SnapshotEntry {
  path: string;
  filename: string;
  createdAt: Date;
  sizeBytes: number;
  encrypted: boolean;
}

/**
 * Lists all backup snapshots in a directory, newest-first.
 *
 * Returns `[]` when the directory does not exist -- this is a normal case
 * for fresh installs where no backup has been written yet, so callers do
 * not need to special-case ENOENT.
 *
 * Files that don't match the canonical backup filename pattern are
 * filtered out. Encrypted snapshots (`.vbundle.enc`) and plaintext
 * snapshots (`.vbundle`) are both returned, distinguished by the
 * `encrypted` flag on each entry.
 */
export async function listSnapshotsInDir(
  dir: string,
): Promise<SnapshotEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const entries: SnapshotEntry[] = [];
  for (const name of names) {
    const createdAt = parseBackupTimestamp(name);
    if (createdAt == null) continue;
    const fullPath = join(dir, name);
    let stats;
    try {
      stats = await stat(fullPath);
    } catch (err) {
      // Race: a file we just listed may have been removed (e.g. by a
      // concurrent prune). Skip it rather than failing the whole listing.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (!stats.isFile()) continue;
    entries.push({
      path: fullPath,
      filename: name,
      createdAt,
      sizeBytes: stats.size,
      encrypted: name.endsWith(".vbundle.enc"),
    });
  }

  // Newest-first by parsed snapshot timestamp. Stable across filesystems
  // since we don't depend on inode/mtime ordering from `readdir`.
  entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return entries;
}

/**
 * Apply retention policy to a backup directory.
 *
 * Lists snapshots newest-first, keeps the first `retention` entries, and
 * `unlink`s the rest. Returns a `{ kept, deleted }` split so callers can
 * log/report what happened without re-listing the directory.
 *
 * The `skipped` flag distinguishes two missing-directory cases:
 *
 * - **Parent missing** (`skipped: true`): the parent of `dir` does not exist.
 *   For offsite destinations this typically means the backing volume is not
 *   available (e.g. iCloud Drive not enabled, external SSD unplugged). The
 *   caller should treat the destination as temporarily unavailable rather
 *   than silently creating it.
 * - **`dir` missing, parent exists** (no `skipped` flag): the destination is
 *   just empty. Returns `{ kept: [], deleted: [] }`. This is the normal
 *   fresh-install case for local backups, where `writeLocalSnapshot` creates
 *   the directory on demand.
 *
 * Treats both `.vbundle` and `.vbundle.enc` files as one pool ordered by
 * parsed timestamp, so mixing plaintext and encrypted snapshots in the same
 * directory retains the newest `retention` regardless of extension.
 */
export async function pruneDir(
  dir: string,
  retention: number,
): Promise<{
  kept: SnapshotEntry[];
  deleted: SnapshotEntry[];
  skipped?: boolean;
}> {
  // If the parent of `dir` does not exist, the destination is unreachable
  // (e.g. iCloud Drive disabled, external volume unplugged). Signal the
  // skipped state so callers can surface a useful error rather than treating
  // an unavailable destination as an empty one.
  try {
    await stat(dirname(dir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kept: [], deleted: [], skipped: true };
    }
    throw err;
  }

  const snapshots = await listSnapshotsInDir(dir);
  const kept = snapshots.slice(0, retention);
  const deleted = snapshots.slice(retention);

  for (const entry of deleted) {
    try {
      await unlink(entry.path);
    } catch (err) {
      // Tolerate races with concurrent prunes / external deletions: a file
      // we just stat'd may have been removed before we could unlink.
      // Anything else (EACCES, EBUSY, ...) should still propagate.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  return { kept, deleted };
}
