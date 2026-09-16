/**
 * Pre-teleport backup policy shared by every teleport surface (CLI and web).
 *
 * A teleport ends with the source assistant being retired, so each surface
 * snapshots the source before any data leaves it. This module holds the
 * decisions those surfaces must agree on: how fresh an existing backup has to
 * be to stand in for a new one, and how a platform (PVC) snapshot is judged
 * restorable. Transport lives with each client; nothing here touches the
 * network or the filesystem.
 */

/** A backup at most this old satisfies the pre-teleport backup requirement. */
export const RECENT_BACKUP_MAX_AGE_MS = 60 * 60 * 1000;

/** How long to wait for a freshly cut platform snapshot to become restorable. */
export const MANAGED_BACKUP_READY_TIMEOUT_MS = 10 * 60 * 1000;

/** How often to re-list platform snapshots while waiting for readiness. */
export const MANAGED_BACKUP_READY_POLL_INTERVAL_MS = 5_000;

/**
 * Whether any of `createdAts` (ISO-8601 timestamps; empty, missing and
 * unparseable values are ignored) falls within `maxAgeMs` of `now`.
 */
export function hasRecentBackup(
  createdAts: Iterable<string | null | undefined>,
  now: number = Date.now(),
  maxAgeMs: number = RECENT_BACKUP_MAX_AGE_MS,
): boolean {
  for (const createdAt of createdAts) {
    if (!createdAt) {
      continue;
    }
    const createdMs = Date.parse(createdAt);
    if (Number.isNaN(createdMs)) {
      continue;
    }
    const age = now - createdMs;
    if (age >= 0 && age <= maxAgeMs) {
      return true;
    }
  }
  return false;
}

/** The fields of a platform backup listing entry the policy reads. */
export interface ManagedBackupEntry {
  snapshot_name?: string;
  created_at?: string;
  ready_to_use?: boolean;
}

/**
 * `created_at` of every restorable platform snapshot. A snapshot still being
 * cut (`ready_to_use: false`) never counts as a usable restore point.
 */
export function readyManagedBackupCreatedAts(
  backups: readonly ManagedBackupEntry[],
): Array<string | undefined> {
  return backups
    .filter((backup) => backup.ready_to_use !== false)
    .map((backup) => backup.created_at);
}

/** Whether the listing shows `snapshotName` as restorable. */
export function managedBackupIsReady(
  backups: readonly ManagedBackupEntry[],
  snapshotName: string,
): boolean {
  return backups.some(
    (backup) =>
      backup.snapshot_name === snapshotName && backup.ready_to_use === true,
  );
}
