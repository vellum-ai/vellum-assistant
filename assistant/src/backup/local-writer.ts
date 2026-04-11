/**
 * Local snapshot writer + retention pruner.
 *
 * The "local" destination is the on-device backup directory (typically under
 * `~/.vellum/backups/local`). It always stores plaintext `.vbundle` files --
 * the encrypted variant is reserved for offsite destinations where the user
 * cannot rely on filesystem-level access controls.
 *
 * Both helpers operate on an explicit directory path so callers can pick the
 * right destination from config and so tests can drive everything against
 * tmp directories without monkey-patching path helpers.
 */

import { copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  listSnapshotsInDir,
  type SnapshotEntry,
} from "./list-snapshots.js";
import { formatBackupFilename } from "./paths.js";

/**
 * Move a freshly-built `.vbundle` temp file into the local backup directory
 * under its canonical timestamped name.
 *
 * - Creates `localDir` (recursively, mode `0o700`) if it does not yet exist.
 * - Renames the temp file to `<localDir>/backup-YYYYMMDD-HHMMSS.vbundle`.
 *   On EXDEV (cross-device move, e.g. when the temp dir is on a different
 *   filesystem than the backup directory) it falls back to copy + unlink.
 * - Returns a `SnapshotEntry` describing the final on-disk file.
 *
 * The caller is expected to pass the same `now` it used when staging the
 * bundle so that the filename, the entry's `createdAt`, and any external
 * record stay in sync.
 */
export async function writeLocalSnapshot(
  tempVBundlePath: string,
  localDir: string,
  now: Date,
): Promise<SnapshotEntry> {
  await mkdir(localDir, { recursive: true, mode: 0o700 });

  const filename = formatBackupFilename(now, { encrypted: false });
  const destPath = join(localDir, filename);

  try {
    await rename(tempVBundlePath, destPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // Cross-device fallback: copy then remove the source so callers don't
    // leak the temp file. We deliberately use copyFile (not a stream pipe)
    // because the bundle has already been fully written to disk by the
    // staging step -- there's nothing to stream.
    await copyFile(tempVBundlePath, destPath);
    await unlink(tempVBundlePath);
  }

  const stats = await stat(destPath);
  return {
    path: destPath,
    filename,
    createdAt: now,
    sizeBytes: stats.size,
    encrypted: false,
  };
}

/**
 * Apply retention policy to the local backup directory.
 *
 * Lists snapshots newest-first, keeps the first `retention` entries, and
 * `unlink`s the rest. Returns a `{ kept, deleted }` split so callers can
 * log/report what happened without re-listing the directory.
 *
 * Edge cases:
 * - Missing directory: returns `{ kept: [], deleted: [] }` (the listing
 *   helper already swallows ENOENT).
 * - `retention >= snapshots.length`: nothing is deleted; everything is kept.
 * - `retention === 0`: every snapshot is deleted. The config schema rejects
 *   `retention: 0` (min is 1), so this branch only fires when callers
 *   explicitly opt into a wipe; treat it as a defensive guarantee.
 */
export async function pruneLocalSnapshots(
  localDir: string,
  retention: number,
): Promise<{ kept: SnapshotEntry[]; deleted: SnapshotEntry[] }> {
  const snapshots = await listSnapshotsInDir(localDir);
  const kept = snapshots.slice(0, retention);
  const deleted = snapshots.slice(retention);

  for (const entry of deleted) {
    try {
      await unlink(entry.path);
    } catch (err) {
      // Tolerate races with concurrent prunes / external deletions: a
      // file we just stat'd may have been removed before we could unlink.
      // Anything else (EACCES, EBUSY, ...) should still propagate.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  return { kept, deleted };
}
