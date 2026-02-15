import { getIpcBlobDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';
import type { IpcBlobRef } from './ipc-contract.js';
import {
  mkdirSync,
  existsSync,
  unlinkSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { readFile, readdir, lstat, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const log = getLogger('ipc-blob-store');

const BLOB_ID_REGEX = /^[0-9a-fA-F-]{36}$/;
const MAX_SCREENSHOT_BLOB_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_AX_BLOB_SIZE = 2 * 1024 * 1024; // 2 MB
const BLOB_EXTENSION = '.blob';

/** Ensure the blob directory exists. Call at daemon startup. */
export function ensureBlobDir(): void {
  const dir = getIpcBlobDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Validate a blob ID matches UUID format. */
export function isValidBlobId(id: string): boolean {
  return BLOB_ID_REGEX.test(id);
}

/**
 * Resolve a blob ID to its absolute file path.
 * Throws if the ID is invalid or the resolved path escapes the blob directory.
 */
export function resolveBlobPath(id: string): string {
  if (!isValidBlobId(id)) {
    throw new Error(`Invalid blob ID: ${id}`);
  }
  const blobDir = getIpcBlobDir();
  const candidate = resolve(join(blobDir, `${id}${BLOB_EXTENSION}`));

  // Symlink protection: verify the resolved path stays within the blob dir.
  // Use resolve() on the blob dir itself to normalize it consistently.
  const normalizedBlobDir = resolve(blobDir);
  if (!candidate.startsWith(normalizedBlobDir + '/') && candidate !== normalizedBlobDir) {
    throw new Error(`Blob path escapes blob directory: ${id}`);
  }

  return candidate;
}

/**
 * Verify that a blob file at the given path is a regular file (not a symlink)
 * and that its realpath stays within the blob directory.
 * Throws if the file is a symlink or escapes the blob directory.
 */
async function assertRegularFileInBlobDir(filePath: string): Promise<void> {
  const fileLstat = await lstat(filePath);
  if (fileLstat.isSymbolicLink()) {
    throw new Error(`Blob file is a symlink: ${filePath}`);
  }
  const real = await realpath(filePath);
  // Realpath both the file and the blob dir so macOS /var → /private/var is handled
  const realBlobDir = await realpath(getIpcBlobDir());
  if (!real.startsWith(realBlobDir + '/')) {
    throw new Error(`Blob realpath escapes blob directory: ${real}`);
  }
}

/**
 * Synchronous variant for use in deleteBlob.
 */
function assertRegularFileInBlobDirSync(filePath: string): void {
  const fileLstat = lstatSync(filePath);
  if (fileLstat.isSymbolicLink()) {
    throw new Error(`Blob file is a symlink: ${filePath}`);
  }
  const real = realpathSync(filePath);
  const realBlobDir = realpathSync(getIpcBlobDir());
  if (!real.startsWith(realBlobDir + '/')) {
    throw new Error(`Blob realpath escapes blob directory: ${real}`);
  }
}

/** Expected kind and encoding for each blob field. */
export const EXPECTED_BLOB_FIELD_METADATA = {
  axTreeBlob: { kind: 'ax_tree' as const, encoding: 'utf8' as const },
  screenshotBlob: { kind: 'screenshot_jpeg' as const, encoding: 'binary' as const },
};

/**
 * Validate that a blob ref's kind and encoding match expectations for a given field.
 * Throws with a descriptive message if they don't match.
 */
export function validateBlobKindEncoding(
  ref: IpcBlobRef,
  field: keyof typeof EXPECTED_BLOB_FIELD_METADATA,
): void {
  const expected = EXPECTED_BLOB_FIELD_METADATA[field];
  if (ref.kind !== expected.kind) {
    throw new Error(
      `Blob kind mismatch for ${field}: expected "${expected.kind}", got "${ref.kind}"`,
    );
  }
  if (ref.encoding !== expected.encoding) {
    throw new Error(
      `Blob encoding mismatch for ${field}: expected "${expected.encoding}", got "${ref.encoding}"`,
    );
  }
}

/**
 * Read a blob file and validate it against the ref metadata.
 * Verifies the file is a regular file (not a symlink) and its realpath
 * stays within the blob directory before reading.
 * Returns the raw bytes.
 */
export async function readBlob(ref: IpcBlobRef): Promise<Buffer> {
  const filePath = resolveBlobPath(ref.id);

  // Symlink-safe: verify the file is a regular file with realpath inside blob dir
  await assertRegularFileInBlobDir(filePath);

  const buf = await readFile(filePath);

  // Validate size matches declared byteLength
  if (buf.byteLength !== ref.byteLength) {
    throw new Error(
      `Blob size mismatch for ${ref.id}: expected ${ref.byteLength} bytes, got ${buf.byteLength}`,
    );
  }

  // Enforce hard size limits by kind
  const maxSize = ref.kind === 'screenshot_jpeg' ? MAX_SCREENSHOT_BLOB_SIZE : MAX_AX_BLOB_SIZE;
  if (buf.byteLength > maxSize) {
    throw new Error(
      `Blob ${ref.id} exceeds size limit for kind "${ref.kind}": ${buf.byteLength} > ${maxSize}`,
    );
  }

  // Verify SHA-256 if provided
  if (ref.sha256) {
    const hash = createHash('sha256').update(buf).digest('hex');
    if (hash !== ref.sha256) {
      throw new Error(
        `Blob SHA-256 mismatch for ${ref.id}: expected ${ref.sha256}, got ${hash}`,
      );
    }
  }

  return buf;
}

/** Delete a blob file by ID. Best-effort, logs warning on failure. */
export function deleteBlob(id: string): void {
  try {
    const filePath = resolveBlobPath(id);
    // Symlink-safe: verify the file is a regular file before deleting
    assertRegularFileInBlobDirSync(filePath);
    unlinkSync(filePath);
  } catch (err) {
    // ENOENT is expected when the blob was already cleaned up
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err, blobId: id }, 'Failed to delete blob');
    }
  }
}

/** Sweep stale blob files older than maxAgeMs. Returns count of deleted files. */
export async function sweepStaleBlobs(maxAgeMs: number): Promise<number> {
  const blobDir = getIpcBlobDir();
  let entries: string[];
  try {
    entries = await readdir(blobDir);
  } catch (err) {
    // Directory may not exist yet if no blobs have been written
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    log.warn({ err }, 'Failed to read blob directory for sweep');
    return 0;
  }

  const now = Date.now();
  let deleted = 0;

  for (const entry of entries) {
    if (!entry.endsWith(BLOB_EXTENSION)) continue;

    const filePath = join(blobDir, entry);
    try {
      // Use lstat (not stat) to detect symlinks without following them
      const fileLstat = await lstat(filePath);
      if (fileLstat.isSymbolicLink()) {
        log.warn({ filePath }, 'Skipping symlink during blob sweep');
        continue;
      }
      const ageMs = now - fileLstat.mtimeMs;
      if (ageMs > maxAgeMs) {
        await unlink(filePath);
        deleted++;
      }
    } catch (err) {
      // File may have been deleted between readdir and stat/unlink
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err, filePath }, 'Failed to stat/delete blob during sweep');
      }
    }
  }

  if (deleted > 0) {
    log.info({ deleted, total: entries.length }, 'Swept stale blobs');
  }

  return deleted;
}
