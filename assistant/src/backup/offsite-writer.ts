/**
 * Offsite snapshot writer with per-destination encryption.
 *
 * "Offsite" destinations are any location outside the local backup directory
 * where the user wants a redundant copy of a just-written local snapshot.
 * Canonical examples: iCloud Drive, an external SSD, a network share.
 *
 * Per-destination `encrypt` flag:
 * - `encrypt: true`  → AES-256-GCM stream-encrypt into `.vbundle.enc`.
 * - `encrypt: false` → plaintext copy into `.vbundle`. Intended for volumes
 *   where the user controls physical access (e.g. an external SSD).
 *
 * Each destination is written independently and sequentially, so one bad
 * destination cannot poison the others: a missing iCloud mount or a broken
 * external drive surfaces as a per-destination `skipped` or `error` in the
 * returned array while every other destination still gets its copy.
 *
 * The helpers are pure with respect to daemon state — they operate on an
 * explicit `localSnapshotPath`, `destinations`, `key`, and `now` so tests can
 * drive the whole surface against temp directories.
 */

import { copyFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import type { BackupDestination } from "../config/schema.js";
import {
  pruneDir,
  type SnapshotEntry,
} from "./list-snapshots.js";
import { deriveSafeAncestor, formatBackupFilename } from "./paths.js";
import { encryptFile } from "./stream-crypt.js";

/**
 * Result of writing a single offsite destination.
 *
 * Exactly one of `entry`, `skipped`, or `error` is meaningful:
 * - `entry` non-null → the write succeeded.
 * - `skipped: "parent-missing"` → the destination's safe ancestor does not
 *   exist (e.g. iCloud Drive not enabled, external volume unplugged). Not an
 *   error — the write is simply deferred until the volume is back. The
 *   ancestor is derived by `deriveSafeAncestor`: for iCloud Drive or
 *   `/Volumes/<name>/...` paths it is a well-known mount root, which lets us
 *   bootstrap intermediate directories on first run; for arbitrary
 *   user-configured paths it falls back to the immediate parent.
 * - `error` set → an unexpected failure while writing. Surfaced as a string
 *   so callers can log without serializing an `Error` object.
 *
 * `destination` always preserves the full config record (path + encrypt) so
 * callers can correlate a result with the destination that produced it.
 */
export interface OffsiteWriteResult {
  destination: BackupDestination;
  entry: SnapshotEntry | null;
  skipped?: "parent-missing";
  error?: string;
}

/**
 * Write a local snapshot to a single offsite destination.
 *
 * Behavior:
 * - If the destination's safe ancestor (see `deriveSafeAncestor`) does not
 *   exist → returns `{ destination, entry: null, skipped: "parent-missing" }`.
 *   The offsite volume is (temporarily) unavailable; the caller should not
 *   treat this as an error.
 * - Otherwise `mkdir -p` the destination directory (mode `0o700`). This
 *   bootstraps any intermediate directories between the safe ancestor and
 *   the destination (e.g. creating `VellumAssistant/backups/` under iCloud
 *   Drive on first run).
 * - If `destination.encrypt === true`, stream-encrypts via `encryptFile`
 *   with the provided `key` and writes `.vbundle.enc`. A missing `key`
 *   here is a programmer error, but per the plan we still catch it rather
 *   than throwing — a broken destination must never poison the others.
 * - If `destination.encrypt === false`, copies the local snapshot into a
 *   `.tmp` sibling and renames into place (atomic; cross-filesystem safe
 *   because `copyFile` handles the copy itself).
 *
 * On any unexpected throw, returns `{ destination, entry: null, error: msg }`.
 */
export async function writeOffsiteSnapshotToOne(
  localSnapshotPath: string,
  destination: BackupDestination,
  key: Buffer | null,
  now: Date,
): Promise<OffsiteWriteResult> {
  try {
    // Ancestor-missing probe: if the destination's derived "safe ancestor"
    // does not exist we treat the destination as temporarily unavailable
    // rather than auto-creating a deep tree we have no reason to own. The
    // ancestor is a well-known mount root (iCloud Drive, /Volumes/<name>)
    // for recognized path shapes, or the immediate parent otherwise. That
    // way an unplugged external drive still skips cleanly while the default
    // iCloud destination can bootstrap its intermediate folders on first run.
    try {
      await stat(deriveSafeAncestor(destination.path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { destination, entry: null, skipped: "parent-missing" };
      }
      throw err;
    }

    // `destination.path` itself may not exist yet — create it now that we
    // know its parent is reachable.
    await mkdir(destination.path, { recursive: true, mode: 0o700 });

    const filename = formatBackupFilename(now, {
      encrypted: destination.encrypt,
    });
    const outputPath = join(destination.path, filename);

    if (destination.encrypt) {
      // Programmer-contract: the caller must have ensured a key exists if any
      // destination is encrypted. We still route this through the catch block
      // so a single broken destination cannot poison the others.
      if (key == null) {
        throw new Error(
          "Offsite destination requires encryption but no key was provided",
        );
      }
      await encryptFile(localSnapshotPath, outputPath, key);
    } else {
      // Atomic plaintext copy: write into a sibling `.tmp` then rename into
      // place. `copyFile` handles cross-filesystem copies, so we don't need
      // the EXDEV fallback dance that `writeLocalSnapshot` uses for a
      // same-device rename.
      const tempPath = `${outputPath}.tmp`;
      await copyFile(localSnapshotPath, tempPath);
      await rename(tempPath, outputPath);
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
 * Write a local snapshot to every configured offsite destination, in order.
 *
 * Sequential by design: parallelizing wouldn't save meaningful wall-clock
 * time (the dominant cost is filesystem IO on potentially-slow network
 * volumes) and sequential writes make per-destination failures trivially
 * observable. Empty array returns `[]` immediately without any stat/mkdir.
 *
 * Returns one `OffsiteWriteResult` per input destination, in the same order
 * as `destinations`. Callers can `filter` the result to extract successes
 * (`entry != null`), skips (`skipped === "parent-missing"`), or errors
 * (`error != null`).
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
 *
 * Retention is applied **per destination** — each keeps its own newest
 * `retention` snapshots independently. A `skipped: true` result means the
 * destination's parent directory is missing (e.g. iCloud Drive disabled);
 * callers should treat this as a transient unavailability rather than an
 * empty directory.
 *
 * Mixed `.vbundle` and `.vbundle.enc` files in a single destination are
 * treated as one pool ordered by parsed timestamp, so retention still holds
 * if a destination's `encrypt` flag changes over its lifetime.
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
