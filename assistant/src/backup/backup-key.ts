/**
 * Backup key management.
 *
 * The backup key is a 32-byte random secret used to authenticate / encrypt
 * workspace backups. It is generated once per install and persisted to disk
 * so subsequent backup/restore operations reuse the same key.
 *
 * This module is intentionally pure: callers pass the full `keyPath` rather
 * than resolving a default location. That keeps the helpers trivially
 * testable against temp directories and avoids any coupling to daemon
 * startup, workspace layout, or global path helpers.
 *
 * On-disk invariants:
 * - Parent directory is created with mode `0o700`.
 * - Key file is written atomically (temp + rename) with mode `0o600`.
 * - Key file is exactly 32 bytes; any other size is treated as corruption.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Required length of the backup key file, in bytes. */
const BACKUP_KEY_LENGTH = 32;

/**
 * Check whether a filesystem path exists without throwing.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the backup key from disk if it exists.
 *
 * Returns the raw 32-byte buffer, or `null` if the file is missing. Intended
 * for read-only callers (e.g. restore paths) that should not create a new
 * key as a side effect.
 *
 * Throws if the file exists but is not exactly 32 bytes -- callers should
 * treat that as a corruption signal rather than silently regenerating.
 */
export async function readBackupKey(keyPath: string): Promise<Buffer | null> {
  if (!(await pathExists(keyPath))) return null;
  const buf = await readFile(keyPath);
  if (buf.length !== BACKUP_KEY_LENGTH) {
    throw new Error(
      `Backup key at ${keyPath} has invalid length ${buf.length} (expected ${BACKUP_KEY_LENGTH})`,
    );
  }
  return buf;
}

/**
 * Ensure a backup key exists at `keyPath`, returning its bytes.
 *
 * - If the file exists, it is read and validated. A wrong-size file throws,
 *   so a corrupt key is never silently replaced.
 * - Otherwise, the parent directory is created (mode `0o700`), a fresh
 *   32-byte random key is generated, written atomically (`.tmp` + rename),
 *   and returned.
 */
export async function ensureBackupKey(keyPath: string): Promise<Buffer> {
  const existing = await readBackupKey(keyPath);
  if (existing) return existing;

  const parent = dirname(keyPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });

  const key = randomBytes(BACKUP_KEY_LENGTH);
  // Use pid suffix to prevent cross-process collisions while ensuring
  // same-process retries overwrite a stale temp file rather than
  // orphaning it on failure. Mirrors the pattern used in
  // `security/encrypted-store.ts`.
  const tmpPath = `${keyPath}.tmp.${process.pid}`;
  await writeFile(tmpPath, key, { mode: 0o600 });
  // Some platforms / umasks ignore the `mode` option on writeFile, so
  // enforce 0o600 explicitly before the rename.
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, keyPath);
  return key;
}
