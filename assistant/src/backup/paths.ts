import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

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

function safeUserInfoHomedir(): string {
  try {
    return userInfo().homedir;
  } catch {
    return "";
  }
}

/**
 * Returns the iCloud Drive root on macOS. This is the "safe ancestor" we use
 * for bootstrapping the default offsite path: if this directory exists iCloud
 * Drive is enabled and we can safely `mkdir -p` the `VellumAssistant/backups`
 * subtree below it.
 *
 * Fallback chain: `process.env.HOME` → `userInfo().homedir` → `homedir()`.
 * Reading `$HOME` at call time keeps the function honest under tests that
 * redirect the home directory mid-process. Uses `||` (not `??`) so an
 * empty-string `HOME` — legal in some sandboxed envs — advances to the next
 * fallback. `homedir()` alone is insufficient because libuv's
 * `uv_os_homedir` returns `$HOME` as-is when it's set (even to `""`) and
 * only consults `getpwuid_r` when `HOME` is unset entirely. `userInfo()`
 * calls `getpwuid_r` directly via `uv_os_get_passwd`, so it returns the
 * passwd-table home regardless of `HOME`. The `userInfo()` call is guarded
 * via `safeUserInfoHomedir()` because it throws `SystemError` when the
 * current UID has no passwd entry (rare on macOS but possible in
 * sandboxed/containerized envs); catching keeps the `homedir()` fallback
 * reachable. Asserts the final result is absolute so callers downstream
 * (`deriveSafeAncestor`, the offsite writer) never see a relative path
 * regardless of how the home lookup resolved.
 */
export function getICloudDriveRoot(): string {
  const home = process.env.HOME || safeUserInfoHomedir() || homedir();
  const root = join(
    home,
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs",
  );
  if (!isAbsolute(root)) {
    throw new Error(
      `getICloudDriveRoot resolved to a relative path: ${root}. ` +
        `HOME, userInfo().homedir, and homedir() all returned empty or relative values.`,
    );
  }
  return root;
}

/**
 * Returns the default offsite backups directory — the iCloud Drive path under
 * the VellumAssistant namespace. Used when no explicit offsite destinations
 * are configured.
 */
export function getDefaultOffsiteBackupsDir(): string {
  return join(getICloudDriveRoot(), "VellumAssistant", "backups");
}

/**
 * Derive the "safe ancestor" for an offsite destination — a directory that
 * must already exist on disk before we are willing to create intermediate
 * directories under it. If the ancestor exists we `mkdir -p destinationPath`;
 * if it is missing we skip the destination (treating it as a transient
 * unavailability like an unplugged drive or disabled iCloud Drive).
 *
 * Derivation rules:
 *   - iCloud Drive subtrees (`~/Library/Mobile Documents/com~apple~CloudDocs/...`)
 *     anchor on the iCloud Drive root. This lets the default destination
 *     (`.../VellumAssistant/backups`) bootstrap on first run without the user
 *     having to pre-create the `VellumAssistant` folder.
 *   - `/Volumes/<name>/...` paths anchor on `/Volumes/<name>`, the macOS
 *     volume mount point. An unmounted drive has no entry in `/Volumes`, so
 *     its destination is correctly skipped rather than bootstrapped on the
 *     root filesystem.
 *   - Everything else falls back to `dirname(destinationPath)` — the original
 *     conservative behavior, preserved for arbitrary user-configured paths
 *     where we have no reliable mount signal.
 */
export function deriveSafeAncestor(destinationPath: string): string {
  const iCloudRoot = getICloudDriveRoot();
  if (
    destinationPath === iCloudRoot ||
    destinationPath.startsWith(`${iCloudRoot}/`)
  ) {
    return iCloudRoot;
  }
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
  // `new Date()` silently normalizes out-of-range calendar values (e.g. Feb 31
  // → March 3). Verify round-trip so malformed filenames can't be accepted and
  // reordered in retention/restore flows.
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
