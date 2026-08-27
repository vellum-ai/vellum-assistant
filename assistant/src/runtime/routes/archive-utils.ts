/**
 * Shared tar.gz archive creation utilities used by
 * log export and profiler export routes.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Maximum compressed archive size (50 MB). */
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

/**
 * Attempts to create a tar.gz archive of `staging` into a Buffer.
 * Returns the Buffer on success, or `undefined` if the archive exceeds
 * the size limit or tar otherwise fails.
 */
export async function createTarGz(
  staging: string,
  maxBytes: number = MAX_ARCHIVE_BYTES,
): Promise<ArrayBuffer | undefined> {
  try {
    // Exceeding maxBuffer rejects, which maps to the undefined failure return.
    const { stdout } = await execFileAsync(
      "tar",
      ["czf", "-", "-C", staging, "."],
      {
        maxBuffer: maxBytes,
        timeout: 30_000,
        encoding: "buffer",
        windowsHide: true,
      },
    );
    const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch {
    return undefined;
  }
}
