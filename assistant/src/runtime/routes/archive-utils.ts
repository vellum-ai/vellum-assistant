/**
 * Shared tar.gz archive creation utilities used by
 * log export and profiler export routes.
 */

import { spawnSync } from "node:child_process";

/** Maximum compressed archive size (50 MB). */
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
