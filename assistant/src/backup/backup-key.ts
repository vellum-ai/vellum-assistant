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
 * - Key file is written atomically (temp + `link`) with mode `0o600`, so
 *   concurrent callers converge on the first winner's bytes.
 * - Key file is exactly 32 bytes; any other size is treated as corruption.
 */

import { randomBytes } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

/** Required length of the backup key file, in bytes. */
const BACKUP_KEY_LENGTH = 32;

/**
 * Check whether a filesystem path exists without throwing.
 *
 * Only `ENOENT` is treated as "missing". Any other errno (EIO, ESTALE,
 * EACCES, ...) is rethrown — we must not silently treat a transient I/O
 * failure as "file is absent" because that can cause an existing backup
 * key to be rotated away under the caller's feet, breaking decryption of
 * data encrypted with the prior key.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
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
 *   32-byte random key is generated, written to a unique tmp file, and
 *   atomically published to `keyPath` via `link()`.
 *
 * Concurrency: callers that race here must all converge on the same bytes
 * — otherwise one caller encrypts data with bytes that will never be
 * persisted and can never be decrypted.
 *
 * We use the canonical Unix atomic-create idiom: write full contents to
 * a per-call tmp file, then `link(tmp, keyPath)`. `link` fails with
 * `EEXIST` if `keyPath` already exists, which makes exactly one racing
 * caller the winner; the rest read the winner's bytes. `rename(2)` by
 * contrast overwrites the destination and is not race-safe here — two
 * renames can leave either caller's bytes on disk regardless of who
 * generated them, so a lost caller would return bytes that don't match
 * what's persisted. `link` avoids that entirely.
 */
export async function ensureBackupKey(keyPath: string): Promise<Buffer> {
  const existing = await readBackupKey(keyPath);
  if (existing) return existing;

  const parent = dirname(keyPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });

  const key = randomBytes(BACKUP_KEY_LENGTH);
  const tmpPath = `${keyPath}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    // `wx` fails if tmpPath somehow exists (stale orphan or collision) so
    // we never silently overwrite another writer's in-flight tmp file.
    await writeFile(tmpPath, key, { flag: "wx", mode: 0o600 });
    // Some platforms / umasks ignore the `mode` option on writeFile, so
    // enforce 0o600 explicitly before publishing.
    await chmod(tmpPath, 0o600);
    try {
      // Atomic publish: only one racing caller's link() succeeds.
      await link(tmpPath, keyPath);
      return key;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      // Another caller won the race. Return their bytes, not ours.
      const winner = await readBackupKey(keyPath);
      if (!winner) {
        throw new Error(
          `link() reported EEXIST but ${keyPath} is unreadable`,
        );
      }
      return winner;
    }
  } finally {
    // Remove our tmp file whether we won (tmp is a hard link to keyPath,
    // safe to unlink), lost, or errored. Best-effort.
    try {
      await unlink(tmpPath);
    } catch {
      // ignore
    }
  }
}
