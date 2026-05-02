/**
 * Local snapshot writer + retention pruner.
 *
 * The "local" destination is the on-device backup directory (typically under
 * `~/.vellum/backups/local`). It always stores plaintext `.vbundle` files —
 * the encrypted variant is reserved for offsite destinations where the user
 * cannot rely on filesystem-level access controls.
 */

import { randomBytes } from "node:crypto";
import { copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

import { pruneDir, type SnapshotEntry } from "./list-snapshots.js";
import { formatBackupFilename } from "./paths.js";

async function resolveUniqueDestPath(
  localDir: string,
  filename: string,
): Promise<string> {
  const primary = join(localDir, filename);
  try {
    await stat(primary);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return primary;
    throw err;
  }
  const extIdx = filename.indexOf(".vbundle");
  const base = filename.slice(0, extIdx);
  const ext = filename.slice(extIdx);
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = randomBytes(3).toString("hex");
    const candidate = join(localDir, `${base}-${token}${ext}`);
    try {
      await stat(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw err;
    }
  }
  throw new Error(
    `Unable to find a unique backup filename under ${localDir} for ${filename}`,
  );
}

/**
 * Move a freshly-built `.vbundle` temp file into the local backup directory.
 */
export async function writeLocalSnapshot(
  tempVBundlePath: string,
  localDir: string,
  now: Date,
): Promise<SnapshotEntry> {
  await mkdir(localDir, { recursive: true, mode: 0o700 });

  const baseFilename = formatBackupFilename(now, { encrypted: false });
  const destPath = await resolveUniqueDestPath(localDir, baseFilename);
  const filename = basename(destPath);

  try {
    await rename(tempVBundlePath, destPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
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
 */
export async function pruneLocalSnapshots(
  localDir: string,
  retention: number,
): Promise<{ kept: SnapshotEntry[]; deleted: SnapshotEntry[] }> {
  const { kept, deleted } = await pruneDir(localDir, retention);
  return { kept, deleted };
}
