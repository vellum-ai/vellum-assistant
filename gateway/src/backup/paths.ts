/**
 * Path and filename helpers for the gateway backup module.
 *
 * The backup key lives in GATEWAY_SECURITY_DIR — outside the workspace
 * and outside the assistant sandbox boundary. The assistant process never
 * has access to this file.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { getGatewaySecurityDir } from "../paths.js";

// ---------------------------------------------------------------------------
// Key path
// ---------------------------------------------------------------------------

/** Filename for the backup encryption key inside GATEWAY_SECURITY_DIR. */
const BACKUP_KEY_FILENAME = "backup.key";

/**
 * Returns the path to the backup encryption key file.
 *
 * The key lives in the gateway security directory, which is:
 * - In Docker: a dedicated volume at /gateway-security (GATEWAY_SECURITY_DIR)
 * - Locally: ~/.vellum/protected/
 *
 * This keeps the key outside the workspace — the assistant's sandbox
 * boundary — so model-driven tools (file_read, shell) cannot access it.
 */
export function getBackupKeyPath(): string {
  return join(getGatewaySecurityDir(), BACKUP_KEY_FILENAME);
}

// ---------------------------------------------------------------------------
// Backup root + local directory
// ---------------------------------------------------------------------------

/**
 * Returns the backup root directory. Respects the `VELLUM_BACKUP_DIR`
 * environment variable override (used in containerized deployments where
 * backups must be on a persistent volume); falls back to `~/.vellum/backups`.
 */
export function getBackupRootDir(): string {
  const override = process.env.VELLUM_BACKUP_DIR?.trim();
  return override || join(homedir(), ".vellum", "backups");
}

/**
 * Returns the directory for local (on-device) backups. By default this lives
 * under `~/.vellum/backups/local`; callers can pass an explicit override from
 * config to place backups elsewhere on disk.
 */
export function getLocalBackupsDir(override?: string | null): string {
  return override ?? join(getBackupRootDir(), "local");
}

// ---------------------------------------------------------------------------
// Backup filenames
// ---------------------------------------------------------------------------

/**
 * Formats a backup filename from a date. Encrypted backups get a `.vbundle.enc`
 * suffix; plaintext backups get `.vbundle`. Timestamp components are in UTC to
 * avoid timezone-induced filename collisions across devices. Milliseconds are
 * included so two backups started in the same UTC second produce distinct
 * filenames rather than silently overwriting each other.
 *
 * Example: `backup-20260411-153045-123.vbundle`
 */
export function formatBackupFilename(
  date: Date,
  { encrypted }: { encrypted: boolean },
): string {
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  const hour = date.getUTCHours().toString().padStart(2, "0");
  const minute = date.getUTCMinutes().toString().padStart(2, "0");
  const second = date.getUTCSeconds().toString().padStart(2, "0");
  const millis = date.getUTCMilliseconds().toString().padStart(3, "0");
  const ext = encrypted ? ".vbundle.enc" : ".vbundle";
  return `backup-${year}${month}${day}-${hour}${minute}${second}-${millis}${ext}`;
}

// Matches `backup-YYYYMMDD-HHMMSS` with an optional `-SSS` milliseconds
// segment (legacy backups written before ms precision was added omit it) and
// an optional `-<hex>` collision suffix that `writeLocalSnapshot` appends when
// the canonical name is already taken. Followed by `.vbundle` or
// `.vbundle.enc`. Kept as a module-level constant so repeated parsing doesn't
// rebuild the RegExp.
const BACKUP_FILENAME_RE =
  /^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{3})(?:-[0-9a-f]+)?)?\.vbundle(?:\.enc)?$/;

/**
 * Inverse of `formatBackupFilename`. Parses a backup filename (with either
 * `.vbundle` or `.vbundle.enc` suffix) and returns the encoded UTC timestamp.
 * Accepts legacy filenames without the `-SSS` milliseconds segment (treated
 * as `.000`). Returns `null` when the filename doesn't match the expected
 * pattern, when a component is out of range, or when the parsed date is
 * invalid.
 */
export function parseBackupTimestamp(filename: string): Date | null {
  const match = BACKUP_FILENAME_RE.exec(filename);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millis] = match;
  const ms = millis ?? "000";
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second) ||
    date.getUTCMilliseconds() !== Number(ms)
  ) {
    return null;
  }
  return date;
}
