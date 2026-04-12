import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  getBackupDirOverride,
  getBackupKeyPathOverride,
} from "../config/env-registry.js";
import type { BackupDestination } from "../config/schema.js";
import { getProtectedDir } from "../util/platform.js";

/**
 * Computes the root ~/.vellum directory without introducing a new export from
 * `platform.ts`. `getProtectedDir()` returns `join(vellumRoot(), "protected")`,
 * so its parent directory is the vellum root. Using `dirname(getProtectedDir())`
 * keeps this module self-contained and avoids expanding the platform.ts surface
 * area just for backups.
 */
function vellumRootFromProtected(): string {
  return dirname(getProtectedDir());
}

/**
 * Returns the backup root directory. Respects the `VELLUM_BACKUP_DIR`
 * environment variable override (used in containerized deployments where
 * backups must be on a persistent volume); falls back to `~/.vellum/backups`.
 */
export function getBackupRootDir(): string {
  return getBackupDirOverride() ?? join(vellumRootFromProtected(), "backups");
}

/**
 * Returns the directory for local (on-device) backups. By default this lives
 * under `~/.vellum/backups/local`; callers can pass an explicit override from
 * config to place backups elsewhere on disk.
 */
export function getLocalBackupsDir(override?: string | null): string {
  return override ?? join(getBackupRootDir(), "local");
}

/**
 * Returns the default offsite backups directory — the iCloud Drive path under
 * the VellumAssistant namespace. Used when no explicit offsite destinations
 * are configured.
 */
export function getDefaultOffsiteBackupsDir(): string {
  return join(
    homedir(),
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs",
    "VellumAssistant",
    "backups",
  );
}

/**
 * Resolves the list of offsite backup destinations from an optional config
 * override. When `override` is `null` (the "not configured" sentinel), returns
 * a single-element array pointing at the iCloud default with encryption
 * enabled. When `override` is an array (including the empty array), returns it
 * unchanged so callers never need to null-check.
 */
export function resolveOffsiteDestinations(
  override?: BackupDestination[] | null,
): BackupDestination[] {
  if (override == null) {
    return [{ path: getDefaultOffsiteBackupsDir(), encrypt: true }];
  }
  return override;
}

/**
 * Returns the path to the backup encryption key file. By default this is
 * `~/.vellum/protected/backup.key`, but the `VELLUM_BACKUP_KEY_PATH` env var
 * can override it for containerized deployments where the key must live on a
 * persistent volume.
 */
export function getBackupKeyPath(): string {
  return getBackupKeyPathOverride() ?? join(getProtectedDir(), "backup.key");
}

/**
 * Formats a backup filename from a date. Encrypted backups get a `.vbundle.enc`
 * suffix; plaintext backups get `.vbundle`. Timestamp components are in UTC to
 * avoid timezone-induced filename collisions across devices.
 *
 * Example: `backup-20260411-153045.vbundle`
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
  const ext = encrypted ? ".vbundle.enc" : ".vbundle";
  return `backup-${year}${month}${day}-${hour}${minute}${second}${ext}`;
}

// Matches `backup-YYYYMMDD-HHMMSS` optionally followed by `.vbundle` or
// `.vbundle.enc`. Kept as a module-level constant so repeated parsing doesn't
// rebuild the RegExp.
const BACKUP_FILENAME_RE =
  /^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.vbundle(?:\.enc)?$/;

/**
 * Inverse of `formatBackupFilename`. Parses a backup filename (with either
 * `.vbundle` or `.vbundle.enc` suffix) and returns the encoded UTC timestamp.
 * Returns `null` when the filename doesn't match the expected pattern, when a
 * component is out of range, or when the parsed date is invalid.
 */
export function parseBackupTimestamp(filename: string): Date | null {
  const match = BACKUP_FILENAME_RE.exec(filename);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}
