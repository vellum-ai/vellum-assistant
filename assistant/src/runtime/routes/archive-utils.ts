/**
 * Shared tar.gz archive creation and size-cap enforcement utilities used by
 * log export and profiler export routes.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Maximum compressed archive size before pruning workspace directories (50 MB). */
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

/**
 * Attempts to create a tar.gz archive of `staging` into a Buffer.
 * Returns the Buffer on success, or `undefined` if the archive exceeds
 * the size limit or tar otherwise fails.
 */
export function createTarGz(
  staging: string,
  maxBytes: number = MAX_ARCHIVE_BYTES,
): ArrayBuffer | undefined {
  const proc = spawnSync("tar", ["czf", "-", "-C", staging, "."], {
    maxBuffer: maxBytes,
    timeout: 30_000,
  });
  if (proc.status !== 0) return undefined;
  const buf = Buffer.isBuffer(proc.stdout)
    ? proc.stdout
    : Buffer.from(proc.stdout);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Returns the name and total byte size of the largest top-level subdirectory
 * inside `dir`, or `undefined` if `dir` has no subdirectories.
 */
export function findLargestSubdirectory(
  dir: string,
): { name: string; bytes: number } | undefined {
  if (!existsSync(dir)) return undefined;

  let largest: { name: string; bytes: number } | undefined;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const bytes = directorySize(fullPath);
    if (!largest || bytes > largest.bytes) {
      largest = { name: entry, bytes };
    }
  }

  return largest;
}

/** Recursively sums the byte size of all files in `dir`. */
export function directorySize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          total += directorySize(fullPath);
        } else if (stat.isFile()) {
          total += stat.size;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  return total;
}

/** Formats a byte count as a human-readable string (e.g. "12.3 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
