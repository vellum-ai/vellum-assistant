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

import { pruneDir, type SnapshotEntry } from "./list-snapshots.js";
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
 * Thin wrapper around the shared `pruneDir` helper in `list-snapshots.ts`.
 * Local backup directories live under `~/.vellum/backups/local` and are
 * created on demand by `writeLocalSnapshot`, so the parent is effectively
 * always present — we strip the `skipped` flag from the returned shape to
 * match the original local-writer contract.
 *
 * Edge cases:
 * - Missing directory: returns `{ kept: [], deleted: [] }` (inherited from
 *   `pruneDir`, which defers to `listSnapshotsInDir`'s ENOENT handling).
 * - `retention >= snapshots.length`: nothing is deleted; everything is kept.
 * - `retention === 0`: every snapshot is deleted. The config schema rejects
 *   `retention: 0` (min is 1), so this branch only fires when callers
 *   explicitly opt into a wipe; treat it as a defensive guarantee.
 */
export async function pruneLocalSnapshots(
  localDir: string,
  retention: number,
): Promise<{ kept: SnapshotEntry[]; deleted: SnapshotEntry[] }> {
  const { kept, deleted } = await pruneDir(localDir, retention);
  return { kept, deleted };
}
