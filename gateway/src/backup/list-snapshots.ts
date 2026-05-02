/**
 * Helpers for listing on-disk backup snapshots.
 *
 * A "snapshot" is any file inside a backup destination directory whose
 * name matches the canonical `backup-YYYYMMDD-HHMMSS.vbundle[.enc]` pattern.
 * Anything else is silently ignored.
 */

import { readdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseBackupTimestamp } from "./paths.js";

export interface SnapshotEntry {
  path: string;
  filename: string;
  createdAt: Date;
  sizeBytes: number;
  encrypted: boolean;
}

/**
 * Lists all backup snapshots in a directory, newest-first.
 * Returns `[]` when the directory does not exist.
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

  entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return entries;
}

/**
 * Apply retention policy to a backup directory.
 * Lists snapshots newest-first, keeps the first `retention`, deletes the rest.
 */
export async function pruneDir(
  dir: string,
  retention: number,
): Promise<{
  kept: SnapshotEntry[];
  deleted: SnapshotEntry[];
  skipped?: boolean;
}> {
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
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  return { kept, deleted };
}
