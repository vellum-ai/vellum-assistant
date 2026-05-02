/**
 * Offsite snapshot writer with per-destination encryption.
 *
 * "Offsite" destinations are any location outside the local backup directory
 * where the user wants a redundant copy. Canonical examples: iCloud Drive,
 * an external SSD, a network share.
 *
 * Per-destination `encrypt` flag:
 * - `encrypt: true`  → AES-256-GCM stream-encrypt into `.vbundle.enc`.
 * - `encrypt: false` → plaintext copy into `.vbundle`.
 *
 * Each destination is written independently and sequentially.
 */

import { copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { SnapshotEntry } from "./list-snapshots.js";
import { pruneDir } from "./list-snapshots.js";
import { formatBackupFilename } from "./paths.js";
import { encryptFile } from "./stream-crypt.js";

export interface BackupDestination {
  path: string;
  encrypt: boolean;
}

export interface OffsiteWriteResult {
  destination: BackupDestination;
  entry: SnapshotEntry | null;
  skipped?: "parent-missing";
  error?: string;
}

/**
 * Derive the "safe ancestor" for an offsite destination — a directory that
 * must already exist on disk before we create intermediate directories
 * under it.
 */
function deriveSafeAncestor(destinationPath: string): string {
  // iCloud Drive subtrees anchor on the iCloud root
  const home = process.env.HOME || "";
  if (home) {
    const iCloudRoot = join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
    if (
      destinationPath === iCloudRoot ||
      destinationPath.startsWith(`${iCloudRoot}/`)
    ) {
      return iCloudRoot;
    }
  }
  // /Volumes/<name>/... paths anchor on the volume mount point
  const volumesPrefix = "/Volumes/";
  if (destinationPath.startsWith(volumesPrefix)) {
    const rest = destinationPath.slice(volumesPrefix.length);
    const slash = rest.indexOf("/");
    const volumeName = slash === -1 ? rest : rest.slice(0, slash);
    if (volumeName.length > 0) {
      return `${volumesPrefix}${volumeName}`;
    }
  }
  return dirname(destinationPath);
}

/**
 * Write a local snapshot to a single offsite destination.
 */
export async function writeOffsiteSnapshotToOne(
  localSnapshotPath: string,
  destination: BackupDestination,
  key: Buffer | null,
  now: Date,
): Promise<OffsiteWriteResult> {
  try {
    try {
      await stat(deriveSafeAncestor(destination.path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { destination, entry: null, skipped: "parent-missing" };
      }
      throw err;
    }

    await mkdir(destination.path, { recursive: true, mode: 0o700 });

    const filename = formatBackupFilename(now, {
      encrypted: destination.encrypt,
    });
    const outputPath = join(destination.path, filename);

    if (destination.encrypt) {
      if (key == null) {
        throw new Error(
          "Offsite destination requires encryption but no key was provided",
        );
      }
      await encryptFile(localSnapshotPath, outputPath, key);
    } else {
      const tempPath = `${outputPath}.tmp`;
      await copyFile(localSnapshotPath, tempPath);
      try {
        await rename(tempPath, outputPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EXDEV") {
          await copyFile(tempPath, outputPath);
          await unlink(tempPath);
        } else {
          throw err;
        }
      }
    }

    const stats = await stat(outputPath);
    return {
      destination,
      entry: {
        path: outputPath,
        filename,
        createdAt: now,
        sizeBytes: stats.size,
        encrypted: destination.encrypt,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { destination, entry: null, error: message };
  }
}

/**
 * Write a local snapshot to every configured offsite destination.
 */
export async function writeOffsiteSnapshotToAll(
  localSnapshotPath: string,
  destinations: BackupDestination[],
  key: Buffer | null,
  now: Date,
): Promise<OffsiteWriteResult[]> {
  if (destinations.length === 0) return [];

  const results: OffsiteWriteResult[] = [];
  for (const destination of destinations) {
    const result = await writeOffsiteSnapshotToOne(
      localSnapshotPath,
      destination,
      key,
      now,
    );
    results.push(result);
  }
  return results;
}

/**
 * Apply retention to every configured offsite destination.
 */
export async function pruneOffsiteSnapshotsInAll(
  destinations: BackupDestination[],
  retention: number,
): Promise<
  Array<{
    destination: BackupDestination;
    kept: SnapshotEntry[];
    deleted: SnapshotEntry[];
    skipped?: boolean;
  }>
> {
  const results: Array<{
    destination: BackupDestination;
    kept: SnapshotEntry[];
    deleted: SnapshotEntry[];
    skipped?: boolean;
  }> = [];
  for (const destination of destinations) {
    const { kept, deleted, skipped } = await pruneDir(
      destination.path,
      retention,
    );
    results.push({ destination, kept, deleted, skipped });
  }
  return results;
}
